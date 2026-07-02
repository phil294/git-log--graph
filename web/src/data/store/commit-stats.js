import { git } from '../../bridge'

/** @type {Record<string, Commit["stats"]>} */
let stats_cache = {}

let is_updating_commit_stats = false
/** @type {Commit[]} */
let queued_commits_for_update_stats = []
export let update_commit_stats = async (/** @type {Commit[]} */ commits_, level = 0) => {
	for (let commit of commits_)
		commit.stats = stats_cache[commit.hash]

	commits_ = commits_.filter(c => ! c.stats)
	if (! commits_.length || level === 0 && /* probably heavily overloaded */queued_commits_for_update_stats.length > 120)
		return
	commits_.forEach(commit => commit.stats = {}) // Prevent from running them twice
	update_commit_stats_fast(commits_) // async
	if (is_updating_commit_stats)
		return void queued_commits_for_update_stats.push(...commits_)
	is_updating_commit_stats = true
	await update_commit_stats_full(commits_)
	is_updating_commit_stats = false
	if (queued_commits_for_update_stats.length) {
		update_commit_stats(queued_commits_for_update_stats.filter(c => c.stats?.insertions == null), level + 1)
		queued_commits_for_update_stats = []
	}
}
/** Only the `files_changed` properties are filled */
async function update_commit_stats_fast(/** @type {Commit[]} */ commits_) {
	// console.time('update_commit_stats_fast')
	// --name-status prints all changed files below one another with M / D etc modifiers in front.
	// Couldn't find any other way to just get the amount of changed files as fast as this.
	let data = await git('show --format="%h" --name-status ' + commits_.map((c) => c.hash).join(' '))
	if (! data)
		return
	let hash = ''
	let files_changed = 0
	for (let line of data.split('\n').filter(Boolean)/* ensure cleanup of last commit */.concat('pseudo-hash')) {
		let [hash_or_file_stati, file_name] = line.split('\t')
		if (hash_or_file_stati && ! file_name) {
			if (hash) {
				let commit = commits_[commits_.findIndex((cp) => cp.hash === hash)]
				if (! commit) {
					console.warn('Details for below error: Hash:', hash, 'Commits:', commits_, 'returned data:', data)
					throw new Error(`Tried to retrieve fast commit stats but the returned hash '${hash}' can't be found in the commit listing`)
				}
				if (commit.stats?.files_changed) {
					// update_commit_stats_full() finished earlier
				} else
					commit.stats = { files_changed }
				files_changed = 0
			}
			hash = hash_or_file_stati
			continue
		}
		files_changed++
	}
	// console.timeEnd('update_commit_stats_fast')
}
/** Can be *very* slow with commits with big files so it's important to keep it to a minimum */
async function update_commit_stats_full(/** @type {Commit[]} */ commits_) {
	// console.time('update_commit_stats_full')
	let data = await git('show --format="%h" --shortstat ' + commits_.map((c) => c.hash).join(' '))
	if (! data)
		return
	let hash = ''
	for (let line of data.split('\n').filter(Boolean)) {
		if (! line.startsWith(' ')) {
			hash = line
			continue
		}
		let stat = { files_changed: 0, insertions: 0, deletions: 0 }
		//  3 files changed, 87 insertions(+), 70 deletions(-)
		for (let stmt of line.trim().split(', ')) {
			let words = stmt.split(' ')
			if (words[1]?.startsWith('file'))
				stat.files_changed = Number(words[0])
			else if (words[1]?.startsWith('insertion'))
				stat.insertions = Number(words[0])
			else if (words[1]?.startsWith('deletion'))
				stat.deletions = Number(words[0])
		}
		let commit = commits_[commits_.findIndex((cp) => cp.hash === hash)]
		if (! commit) {
			// Happened once, but no idea why
			console.warn('Details for below error: Hash:', hash, 'Commits:', commits_, 'returned data:', data)
			throw new Error(`Tried to retrieve full commit stats but the returned hash '${hash}' can't be found in the commit listing`)
		}
		if (! commit.merge && commit.stats?.files_changed !== stat.files_changed)
			// Happens rarely for some reason
			console.warn('Commit stats files_changed mismatch between fast and full mode. Fast: ', commit.stats?.files_changed, ', full:', stat.files_changed, ', commit: ', commit)

		commit.stats = stat
		stats_cache[hash] = stat
	}
	// console.timeEnd('update_commit_stats_full')
}
