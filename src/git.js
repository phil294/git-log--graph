let vscode = require('vscode')
let util = require('util')
let { relative, isAbsolute } = require('path')
const { existsSync } = require('fs')
let { realpath } = require('fs').promises
let exec = util.promisify(require('child_process').exec)

/**
 * @param EXT_ID {string}
 * @param logger {ReturnType<import('./logger')>}
 * @param args {{on_repo_external_state_change:()=>any, on_repo_infos_change:()=>any}}
 */
module.exports.get_git = function(EXT_ID, logger, { on_repo_external_state_change, on_repo_infos_change }) {
	/** @type {import('./vscode.git').API & import('./vscode-extra.git').API} */
	let api = vscode.extensions.getExtension('vscode.git')?.exports.getAPI(1) || (() => { throw 'VSCode official Git Extension not found, did you disable it?' })()
	let last_git_execution = 0

	/** @type {Record<string,string>} */
	let repo_state_cache = {}
	function start_observing_repo(/** @type {import('./vscode.git').Repository} */ repo) {
		logger.info('start observing repo ' + repo.rootUri.fsPath)
		return repo.state.onDidChange(() => {
			// There's no event info available so we need to compare. (https://github.com/microsoft/vscode/issues/142313#issuecomment-1056939973)
			// Work tree changes is required for detecting stashes.
			// Detecting branch additions is currently *not possible*.
			let state_cache = [repo.state.mergeChanges.map((c) => c.uri.fsPath).join(','), repo.state.HEAD?.commit, repo.state.workingTreeChanges.map((c) => c.uri.fsPath).join(','), repo.state.indexChanges.map((c) => c.uri.fsPath).join(',')].join(';')
			let is_initial_change = ! repo_state_cache[repo.rootUri.fsPath]
			if (repo_state_cache[repo.rootUri.fsPath] === state_cache)
				return
			repo_state_cache[repo.rootUri.fsPath] = state_cache
			if (is_initial_change)
				return
			// Changes done via interface already do a refresh afterwards, so prevent a second one.
			// An alternative to margin wait below does not really seem feasible, as it's hard to tell when a change
			// was made by the user. Some commands never do (log, branch --list, ...), others only
			// sometimes, depending on work tree and command success. So it would be necessary to
			// have a separate change detection logic based on .git/HEAD and .git/index because
			// this one right here is too delayed. vscode.git keeps its own state and refreshes quite
			// slowly but we need immediate refreshes in the interface while *not* doing duplicate
			// refreshes for the same action. It seems the sanest solution is just a dumb timer.
			// The delay margin should be as big as possible in case the repo is *very* big and
			// a false positive resulting from a a too small margin can lead to *seconds* of
			// unnecessary reloading, and it should be as small as possible to prevent actual external
			// changes from being detected which could happen if the user e.g. checks out a branch in
			// the extension's interface and then quickly commits something from VSCode's SCM view
			// before the margin elapsed.
			// Note that `last_git_execution` would usually refer to a `git log` action because any
			// git action in the web view results in a refresh / log being sent afterwards.
			let margin = 1500
			if (Date.now() - last_git_execution < margin)
				return
			// We have to observe all repos even if they aren't the selected one because
			// there is no apparent way to unsubscribe from repo state changes. So filter:
			if (repo.rootUri.fsPath !== selected_repo_path)
				return
			logger.info('repo watcher: external index/head change') // from external, e.g. cli or committed via vscode ui
			return on_repo_external_state_change()
		})
	}

	/** @type {import('./vscode.git').Repository[]} */
	let repos_cache = []
	function repos_changed() {
		// onDidOpenRepository fires multiple times. At first, there isn't even a repos change..
		if (api.repositories.length === repos_cache.length)
			return
		debounce(() => {
			logger.info('workspace: repo(s) added/removed')
			api.repositories
				.filter((repo) => ! repos_cache.some(r => repo.rootUri.path === r.rootUri.path))
				.forEach((repo) =>
					start_observing_repo(repo))
			repos_cache = api.repositories.slice()
			return on_repo_infos_change()
		}, 200)
	}
	api.onDidOpenRepository(repos_changed)
	api.onDidCloseRepository(repos_changed)
	api.onDidChangeState(repos_changed)
	repos_changed()

	let selected_repo_path = ''
	return {
		/** Guaranteed to be unique by `path`, yet as short of a `name` as possible */
		get_repo_infos() {
			let arr = api.repositories.map(r => {
				let segments = r.rootUri.fsPath.split(/[/\\]/)
				let name = segments.pop() || '???'
				return { path: r.rootUri.fsPath, segments, name }
			})
			for (let i = 0; i < arr.length; i++) {
				let el = not_null(arr[i])
				let dupes = arr.slice(i + 1).filter(el2 =>
					el2.name === el.name)
				if (! dupes.length)
					continue
				dupes.unshift(el)
				for (let segment_i = 0; segment_i < el.segments.length; segment_i++) {
					dupes.forEach(d =>
						d.name = d.segments.pop() + '/' + d.name)
					let still_dupes = dupes.some((d, di) =>
						dupes.findIndex(d2 => d.name === d2.name) !== di)
					if (! still_dupes)
						break
				}
			}
			return arr.map(el => ({ path: el.path, name: el.name }))
			// TODO:
			// .sort_like_vscode_git_ui()
			// .sort((a, b) => a.name.localeCompare(b.name))
		},
		async run(/** @type {string} */ args, /** @type {string | undefined} */ repo_path = undefined) {
			let cwd = vscode.workspace.getConfiguration(EXT_ID).get('folder')
			let cmd = vscode.workspace.getConfiguration(EXT_ID).get('git-path') ||
				vscode.workspace.getConfiguration('git').get('path') || 'git'
			if (! cwd) {
				cwd = repo_path || selected_repo_path
				if (! cwd)
					throw new Error('No repo selected!')
				let has_matching_repo = api.repositories.some(r => r.rootUri.fsPath === cwd)
				if (! has_matching_repo)
					throw new Error(`Tried to run 'git ${args.slice(0, 25)}' but repo not loaded (yet?): ${cwd}`)
			}
			try {
				let { stdout } = await exec(
					// cmd may include spaces such as C:\Program Files, while args is passed insecurely
					`"${cmd.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"` + // TODO: use/share utils/quote-escape
					` ${args}`, {
						cwd,
						// 35 MB. For scale, Linux kernel git graph (1 mio commits) in extension format
						// is 538 MB or 7.4 MB for the first 15k commits
						maxBuffer: 1024 * 1024 * 35,
						env: {
							...process.env,
							// Get the built-in git env to support interavtive password prompts using ASKPASS
							...api.git.env,
						},
					})
				last_git_execution = Date.now()
				return stdout
			} catch (error) {
				// stderr contains the full message, message itself is too short otherwise
				// In the case of multi-step commands like branch drop merge, stdout instead
				// contains the actual important message.
				// When the error comes from the internals of cp/exec, it's in .message.
				error.message = [error.stderr, error.stdout].join('\n').trim() || error.message || error.code
				throw error
			}
		},
		set_selected_repo_path(/** @type {string} */ path) {
			logger.info('set selected repo path ' + path)
			selected_repo_path = path
		},
		async get_repo_path_for_uri(/** @type {vscode.Uri} */ uri) {
			if (! existsSync(uri.fsPath))
				return null
			let uri_path = await realpath(uri.fsPath).catch(e => { throw new Error(e) /* https://github.com/nodejs/node/issues/30944 */ })
			return ((await Promise.all(api.repositories.map(async (repo) => {
				let repo_path = await realpath(repo.rootUri.fsPath).catch(e => { throw new Error(e) /* https://github.com/nodejs/node/issues/30944 */ })
				return { repo_path, fs_path: repo.rootUri.fsPath }
			})))).filter(({ repo_path }) => {
				// if repo includes uri: stackoverflow.com/q/37521893
				let rel = relative(repo_path, uri_path)
				return rel != null && ! rel.startsWith('..') && ! isAbsolute(rel)
			}).sort((a, b) =>
				// There can be multiple matches with git submodules, in which case the longest
				// path will be the right one
				b.repo_path.length - a.repo_path.length,
			).at(0)?.fs_path ?? null
		},
	}
}
