let vscode = require('vscode')
let path = require('path')
let crypto = require('crypto')
let RelativeTime = require('@yaireo/relative-time')
let relative_time = new RelativeTime()
require('./globals')

let { get_git } = require('./git')
const create_logger = require('./logger')
const { get_state } = require('./state')

let EXT_NAME = 'GitLG'
let EXT_ID = 'git-log--graph'
let START_CMD = 'start'
let BLAME_CMD = 'blame-line'

/** @type {vscode.WebviewPanel | vscode.WebviewView | null} */
let webview_container = null

let logger = create_logger(EXT_NAME, EXT_ID)
module.exports.log = logger

/**
 * Necessary because there's no global error handler for VSCode extensions https://github.com/microsoft/vscode/issues/45264
 * and the suggested alternative of installing a TelemetryLogger fails when the user has set {"telemetry.telemetryLevel": "off"}.
 * Also we're not doing any telemetry but only want to catch the errors for better formatting and display.
 eslint-disable-next-line jsdoc/reject-any-type
 * @template {AnyFunction} Fun
 * @param fun {Fun}
 * @returns {Fun}
 */
function intercept_errors(fun) {
	return /** @type {Fun} */ (async (...args) => {
		try {
			return await fun(...args)
		} catch (e) {
			logger.error(e)
			// VSCode api callbacks often don't seem to preserve proper stack trace so not even console.trace() in logger helps
			console.error('The above error happened inside:', fun.toString())
			throw e
		}
	})
}

// When you convert a folder into a workspace by adding another folder, the extension is de- and reactivated
// but the webview webview_container isn't destroyed even though we instruct it to (with subscriptions).
// This is an unresolved bug in VSCode and it seems there is nothing you can do. https://github.com/microsoft/vscode/issues/158839
module.exports.activate = intercept_errors(function(/** @type {vscode.ExtensionContext} */ context) {
	logger.info('extension activate')

	function post_message(/** @type {BridgeMessage} */ msg) {
		logger.debug('send to webview: ' + JSON.stringify(msg))
		return webview_container?.webview.postMessage(msg)
	}
	function push_message_id(/** @type {string} */ id) {
		return post_message({
			type: 'push-to-web',
			id,
		})
	}

	let get_config = () =>
		vscode.workspace.getConfiguration(EXT_ID)

	let git = get_git(EXT_ID, logger, {
		on_repo_external_state_change() {
			return push_message_id('repo-external-state-change')
		},
		on_repo_infos_change() {
			return state('repo-infos').set(git.get_repo_infos())
		},
	})

	let { state, add_state_change_listener } = get_state({
		context,
		git,
		get_config,
		on_broadcast: (key, value) => post_message({
			type: 'push-to-web',
			id: 'state-update',
			data: { key, value },
		}),
	})

	function wait_until_web_ready() {
		return new Promise(is_ready => {
			if (state('web-phase').get() === 'ready')
				is_ready(true)
			else
				add_state_change_listener('web-phase', (phase) => {
					if (phase === 'ready') {
						is_ready(true)
						return 'unsubscribe'
					}
					return 'stay-subscribed'
				})
		})
	}

	git.set_selected_repo_path(state('selected-repo-path').get() || '')

	async function populate_webview() {
		if (! webview_container)
			return

		let view = webview_container.webview
		view.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'web-dist')] }

		view.onDidReceiveMessage(intercept_errors((/** @type {BridgeMessage} */ message) => {
			logger.debug('receive from webview: ' + JSON.stringify(message))
			let data = message.data
			async function h(/** @type {AnyFunction} */ func) {
				/** @type {BridgeMessage} */
				let resp = {
					type: 'response-to-web',
					id: message.id,
				}
				let caller_stack = new Error().stack
				try {
					resp.data = await func()
				} catch (error) {
					console.warn(error, caller_stack, func, data)
					// We can't really just be passing error along here because it might be serialized as empty {}
					resp.error = error.message || error
				}
				return post_message(resp)
			}
			switch (message.type) {
				case 'request-from-web':
					switch (message.command) {
						case 'git': return h(() =>
							git.run(data.args).catch(e => {
								if (data.ignore_errors) // /TODO: rename this so it differs from the unrelated action[].ignore_errors
									return
								throw e
							}))
						case 'show-error-message': return h(() =>
							logger.error(data))
						case 'show-information-message': return h(() =>
							vscode.window.showInformationMessage(data))
						case 'get-state': return h(() =>
							state(data).get())
						case 'set-state': return h(() =>
							state(data.key).set(data.value, { broadcast: false }))
						case 'open-diff': return h(() => {
							let uri_1 = vscode.Uri.parse(`${EXT_ID}-git-show:${data.uris[0]}`)
							let uri_2 = vscode.Uri.parse(`${EXT_ID}-git-show:${data.uris[1]}`)
							return vscode.commands.executeCommand('vscode.diff', uri_1, uri_2, data.title)
						})
						case 'open-multi-diff': return h(() =>
							vscode.commands.executeCommand('vscode.changes',
								data.title,
								data.uris.map((/** @type {[string,string]} */ _uris) => [
									vscode.Uri.parse(''), // Unsure what VSCode expects here. Not documented either
									vscode.Uri.parse(`${EXT_ID}-git-show:${_uris[0]}`),
									vscode.Uri.parse(`${EXT_ID}-git-show:${_uris[1]}`),
								])))
						case 'view-rev': return h(() => {
							let uri = vscode.Uri.parse(`${EXT_ID}-git-show:${data.uri}`)
							return vscode.commands.executeCommand('vscode.open', uri)
						})
						case 'open-file': return h(() => {
							// vscode.workspace.workspaceFolders is NOT necessarily in the same order as git-api.repositories
							let workspace = state('selected-repo-path').get() || ''
							let uri = vscode.Uri.file(path.join(workspace, data.uri))
							return vscode.commands.executeCommand('vscode.open', uri)
						})
						case 'clipboard-write-text': return h(() =>
							vscode.env.clipboard.writeText(data))
						case 'sha256-hash': return h(() =>
							crypto.createHash('sha256').update(data).digest('hex'))
					}
			}
			return undefined
		}))

		vscode.workspace.onDidChangeConfiguration(intercept_errors((event) => {
			if (event.affectsConfiguration(EXT_ID))
				debounce(intercept_errors(() =>
					state('config').set(state('config').get()))
				, 500)
		}))

		let is_production = context.extensionMode === vscode.ExtensionMode.Production || process.env.GIT_LOG__GRAPH_MODE === 'production'
		let dev_server_url = 'http://localhost:5173'

		let csp = 'default-src \'none\'; ' +
			`style-src ${view.cspSource} 'unsafe-inline' ` +
				(is_production ? '' : dev_server_url) + '; ' +
			`script-src ${view.cspSource} 'unsafe-inline' ` +
				(is_production ? '' : `${dev_server_url} 'unsafe-eval'`) + '; ' +
			`font-src ${view.cspSource} ` +
				(is_production ? '' : dev_server_url) + '; ' +
			'connect-src https://www.gravatar.com ' +
				(is_production ? '' : '*') + '; ' +
			`img-src ${view.cspSource} data: https://www.gravatar.com ` +
				(is_production ? '' : dev_server_url) + '; '
		let base_url = is_production
			? view.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'web-dist')) + '/'
			: dev_server_url
		let custom_css = get_config().get('custom-css')
		let loading_prompt = is_production
			? 'Loading (this should not take long)'
			: 'Trying to connect to dev server... See CONTRIBUTING.md > "Building" for instructions'

		view.html = `
			<!DOCTYPE html>
			<html lang='en'>
			<head>
				<meta charset='UTF-8'>
				<meta http-equiv='Content-Security-Policy' content="${csp}">
				<meta name='viewport' content='width=device-width, initial-scale=1.0'>
				<base href="${base_url}" />
				<link href='./index.css' rel='stylesheet' crossorigin>
				<title>${EXT_NAME}</title>
				<script type="module" crossorigin src='./index.js'></script>
			</head>
			<body>
			<div id='app'>
				<p style="color: grey;">${loading_prompt}</p>
			</div>
			<style>${custom_css}</style>
			</body>
			</html>`
	}

	// Needed for git diff views
	context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(`${EXT_ID}-git-show`, {
		provideTextDocumentContent: intercept_errors((uri) =>
			git.run(`show "${uri.path}"`).catch(() => ''),
		),
	}))

	// General start, will choose from creating/show editor panel or showing side nav view depending on config
	context.subscriptions.push(vscode.commands.registerCommand(`${EXT_ID}.${START_CMD}`, intercept_errors(async (args) => {
		logger.info('start command')
		if (args?.rootUri) // invoked via menu scm/title
			state('selected-repo-path').set(await git.get_repo_path_for_uri(args.rootUri) || '')
		if (get_config().get('position') === 'editor') {
			if (webview_container)
				// Repeated editor panel show
				return /** @type {vscode.WebviewPanel} */ (webview_container).reveal()
			// First editor panel creation + show
			logger.info('create new webview panel')
			webview_container = vscode.window.createWebviewPanel(EXT_ID, EXT_NAME, vscode.window.activeTextEditor?.viewColumn || 1, { retainContextWhenHidden: true })
			webview_container.iconPath = vscode.Uri.joinPath(context.extensionUri, 'img', 'logo.png')
			webview_container.onDidDispose(() => {
				state('web-phase').set('dead', { broadcast: false })
				webview_container = null
			})
			context.subscriptions.push(webview_container)
			return populate_webview()
		} else {
			// Repeated side nav view show
			logger.info('show view');
			/** @type {vscode.WebviewView | null} */ (webview_container)?.show()
		}
	})))

	// Close the editor(tab)
	context.subscriptions.push(vscode.commands.registerCommand('git-log--graph.close', intercept_errors(() => {
		if (get_config().get('position') !== 'editor')
			return void vscode.window.showInformationMessage('This command can only be used if GitLG isn\'t configured as a main editor (tab).')
		if (! webview_container)
			return void vscode.window.showInformationMessage('GitLG editor tab is not running.')
		logger.info('close command');
		/** @type {vscode.WebviewPanel} */ (webview_container).dispose()
	})))

	// Toggle the editor(tab)
	context.subscriptions.push(vscode.commands.registerCommand('git-log--graph.toggle', intercept_errors(() => {
		if (get_config().get('position') !== 'editor')
			return vscode.window.showInformationMessage('This command can only be used if GitLG isn\'t configured as a main editor (tab).')
		logger.info('toggle command')
		if (webview_container)
			/** @type {vscode.WebviewPanel} */ (webview_container).dispose()
		return vscode.commands.executeCommand(`${EXT_ID}.${START_CMD}`)
	})))

	// First editor panel creation + show, but automatically after restart / resume previous session.
	// It would be possible to restore some web view state here too
	vscode.window.registerWebviewPanelSerializer(EXT_ID, {
		deserializeWebviewPanel: intercept_errors((deserialized_panel) => {
			logger.info('deserialize web panel (rebuild editor tab from last session)')
			webview_container = deserialized_panel
			webview_container.onDidDispose(() => { webview_container = null })
			context.subscriptions.push(webview_container)
			populate_webview()
			return Promise.resolve()
		}),
	})

	// Side nav view setup
	context.subscriptions.push(vscode.window.registerWebviewViewProvider(EXT_ID, {
		// Side nav view creation
		resolveWebviewView: intercept_errors((view) => {
			if (get_config().get('position') === 'editor')
				return
			logger.info('provide view')
			webview_container = view
			return populate_webview()
		}),
	}, { webviewOptions: { retainContextWhenHidden: true } }))

	let status_bar_item_start = vscode.window.createStatusBarItem(START_CMD, vscode.StatusBarAlignment.Left)
	status_bar_item_start.command = `${EXT_ID}.${START_CMD}`
	status_bar_item_start.name = `${EXT_NAME}: ${START_CMD}`
	context.subscriptions.push(status_bar_item_start)
	status_bar_item_start.text = '$(git-branch) GitLG'
	status_bar_item_start.tooltip = 'Open up the main view of the GitLG extension'
	status_bar_item_start.show()

	let status_bar_item_blame = vscode.window.createStatusBarItem(BLAME_CMD, vscode.StatusBarAlignment.Right, 500)
	status_bar_item_blame.command = `${EXT_ID}.${BLAME_CMD}`
	status_bar_item_blame.name = `${EXT_NAME}: ${BLAME_CMD}`
	context.subscriptions.push(status_bar_item_blame)
	status_bar_item_blame.text = ''
	status_bar_item_blame.tooltip = 'Show and focus this commit in the main view of the GitLG extension'
	status_bar_item_blame.show()

	let current_line = -1
	/** @type {string | null} */
	let current_line_repo_path = null
	let current_line_long_hash = ''
	/** @type {NodeJS.Timeout|null} */
	let line_change_debouncer = null
	function hide_blame() {
		if (line_change_debouncer)
			clearTimeout(line_change_debouncer)
		current_line_long_hash = ''
		status_bar_item_blame.text = ''
	}
	function show_blame(/** @type {vscode.TextEditor} */ text_editor) {
		let doc = text_editor.document
		let uri = doc.uri
		if (uri.scheme !== 'file' || doc.languageId === 'log' || doc.languageId === 'Log' || uri.path.includes('extension-output') || uri.path.includes(EXT_ID)) // vscode/issues/206118
			return
		if (text_editor.selection.active.line === current_line)
			return
		current_line = text_editor.selection.active.line
		if (line_change_debouncer)
			clearTimeout(line_change_debouncer)
		line_change_debouncer = setTimeout(intercept_errors(async () => {
			current_line_repo_path = await git.get_repo_path_for_uri(uri)
			if (! current_line_repo_path)
				return hide_blame()

			let blamed = await git.run(`blame -L${current_line + 1},${current_line + 1} --porcelain -- ${uri.fsPath}`, current_line_repo_path)
				.then((b) => b.split('\n')).catch(() => null)
			if (! blamed)
				return hide_blame()

			// apparently impossible to get the short form right away in easy machine readable format?
			current_line_long_hash = blamed[0]?.slice(0, 40) || ''
			let author = blamed[1]?.slice(7)
			let time_ago = relative_time.from(new Date(Number(blamed[3]?.slice(12)) * 1000))
			let status_bar_text = (get_config().get('status-bar-blame-text') || '')
				.replaceAll('{AUTHOR}', author)
				.replaceAll('{TIME_AGO}', time_ago)
			status_bar_item_blame.text = status_bar_text
		}), 150)
	}
	vscode.window.onDidChangeActiveTextEditor(intercept_errors((text_editor) => {
		if (! text_editor)
			return hide_blame()
		return show_blame(text_editor)
	}))
	vscode.window.onDidChangeTextEditorSelection(intercept_errors(({ textEditor: text_editor }) => {
		show_blame(text_editor)
	}))
	context.subscriptions.push(vscode.commands.registerCommand(`${EXT_ID}.${BLAME_CMD}`, intercept_errors(async () => {
		logger.info('blame cmd')
		if (! current_line_long_hash || ! current_line_repo_path)
			return
		state('selected-repo-path').set(current_line_repo_path)
		let focus_commit_hash = ((await git.run(`rev-parse --short ${current_line_long_hash}`))).trim()
		current_line_long_hash = ''
		state('repo:selected-commits-hashes').set([focus_commit_hash])
		vscode.commands.executeCommand(`${EXT_ID}.${START_CMD}`)
		await wait_until_web_ready()
		return push_message_id('show-selected-commit')
	})))

	context.subscriptions.push(vscode.commands.registerCommand('git-log--graph.refresh', intercept_errors(() => {
		logger.info('refresh command')
		return push_message_id('refresh-main-view')
	})))

	// public api of this extension:
	return { git, post_message, webview_container, context, state }
})

module.exports.deactivate = function() {
	return logger.info('extension deactivate')
}
