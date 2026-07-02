<template>
	<div class="commit-diff">
		<h3>
			{{ props.commit2 ? 'Changes between commits' : 'Changes' }} ({{ file_diffs?.length || 0 }})
		</h3>
		<aside class="actions center">
			<button class="row" title="View Changes in Multi Diff" @click="show_multi_diff()">
				<i class="codicon codicon-diff-multiple" />
			</button>
			<button v-if="render_style==='tree'" class="row" title="View as list" @click="render_style='list'">
				<i class="codicon codicon-list-tree" />
			</button>
			<button v-else class="row" title="View as tree" @click="render_style='tree'">
				<i class="codicon codicon-list-flat" />
			</button>
		</aside>

		<div v-if="!file_diffs" class="loading padding">
			Loading files...
		</div>

		<template-file-change-define v-slot="{ file }">
			<button :title="file.insertions+' insertions, '+file.deletions+' deletions'" class="change center gap-10">
				<div v-if="file.is_creation" class="align-center" title="This file was added">
					<i class="codicon codicon-add grey" />
				</div>
				<div v-if="file.is_deletion" class="align-center" title="This file was deleted">
					<i class="codicon codicon-trash grey" />
				</div>
				<div v-if="file.rename_path" class="align-center" title="This file was renamed">
					<i class="codicon codicon-diff-renamed grey" />
				</div>
				<progress :value="(file.insertions / (file.insertions + file.deletions)) || 0" class="diff" />
				<div class="count">
					{{ (file.insertions + file.deletions) || 0 }}
				</div>
			</button>
		</template-file-change-define>
		<template-file-actions-define v-slot="{ file }">
			<div class="file-actions row align-center">
				<button class="row show-file" title="Show file history" @click.stop="show_file(file)">
					<i class="codicon codicon-history" />
				</button>
				<button class="row view-rev" title="View File at this Revision" @click.stop="view_rev(file)">
					<i class="codicon codicon-git-commit" />
				</button>
				<button class="row open-file" title="Open file" @click.stop="open_file(file)">
					<i class="codicon codicon-go-to-file" />
				</button>
			</div>
		</template-file-actions-define>

		<ul v-if="files_list" class="list">
			<li v-for="file of files_list" :key="file.path" class="list-row flex-1 row align-center gap-10" role="button" @click="show_diff(file)">
				<div class="flex-1 fill-h row align-center gap-10">
					<img :src="file.icon_path" aria-hidden="true">
					<div :title="file.filename" class="filename">
						{{ file.filename }}
					</div>
					<div :title="file.dir" class="dir">
						{{ file.dir }}
					</div>
				</div>
				<template-file-actions-reuse :file="file" />
				<template-file-change-reuse :file="file" />
			</li>
		</ul>

		<template-tree-node-define v-slot="{ node }">
			<details class="tree-node" open>
				<summary :title="node.path">
					{{ node.path }}
				</summary>
				<div class="body">
					<template-tree-node-reuse v-for="child of node.children" :key="child.path" :node="child" />
					<template v-for="file of node.files" :key="file.path">
						<button class="fill-w row align-center gap-10" @click="show_diff(file)">
							<img :src="file.icon_path" aria-hidden="true">
							<div :title="file.filename" class="filename flex-1">
								{{ file.filename }}
							</div>
							<template-file-actions-reuse :file="file" />
							<template-file-change-reuse :file="file" />
						</button>
					</template>
				</div>
			</details>
		</template-tree-node-define>
		<div v-if="files_tree" class="tree">
			<template-tree-node-reuse :node="files_tree" />
		</div>
	</div>
</template>
<script setup>
import { computed, ref, watchEffect } from 'vue'
import { exchange_message, git } from '../bridge.js'
import { trigger_main_refresh } from '../data/store'
import { createReusableTemplate } from '@vueuse/core'
import file_extension_icon_path_mapping from '../data/file-extension-icon-path-mapping.json'
import state from '../data/state.js'

/**
 * @typedef {{
 *	path: string
 *	new_path: string
 *	insertions: number
 *	deletions: number
 *  is_deletion?: boolean
 *  is_creation?: boolean
 *  rename_path?: string
 * }} FileDiff
 */

let props = defineProps({
	commit1: {
		/** @type {Vue.PropType<Commit>} */
		type: Object,
		required: true,
	},
	commit2: {
		/** @type {Vue.PropType<Commit | null>} */
		type: Object,
		required: false,
		default: null,
	},
})

/** @type {Vue.Ref<FileDiff[] | null>} */
let file_diffs = ref(null)

/**
 * Expand git's compact rename spec into its old and new paths.
 * Handles `dir/{old => new}/file`, `{old => new}/file`, `dir/{ => new}/file`,
 * `dir/{old => }/file` and the plain `old => new` form.
 * @type {(spec: string) => { old_path: string, new_path: string }}
 */
function split_rename(spec) {
	let brace = spec.match(/^(.*)\{(.*) => (.*)\}(.*)$/)
	if (brace) {
		let pre = brace[1] || ''
		let post = brace[4] || ''
		let join = (/** @type {string} */ mid) => (pre + mid + post).replace(/\/{2,}/g, '/')
		return { old_path: join(brace[2] || ''), new_path: join(brace[3] || '') }
	}
	let split = spec.split(' => ')
	let from = split[0] || ''
	return { old_path: from, new_path: split[1] || from }
}

function git_numstat_summary_to_changes_array(/** @type {string} */ out) {
	return Object.values(out.split('\n').filter(Boolean)
		.reduce((/** @type {Record<string, FileDiff>} */ all, line) => {
			if (line.startsWith(' ')) {
				let split = line.split(' ')
				if (split[1] === 'delete' || split[1] === 'create') {
					let path = split.slice(4).join(' ')
					if (all[path])
						if (split[1] === 'delete')
							all[path].is_deletion = true
						else if (split[1] === 'create')
							all[path].is_creation = true
				} else if (split[1] === 'rename') {
					// --summary output is obviously not meant to be parsed
					// rename Theme/Chicago95/{index.theme => index1.theme} (100%)
					let match = line.match(/^ rename (.+) \(\d+%\)$/)
					let spec = match?.[1] || ''
					if (spec) {
						let change = all[split_rename(spec).old_path]
						if (change)
							change.rename_path = spec
					}
				}
			} else {
				let split = line.split('\t')
				let path = split[2] || ''
				let new_path = path
				/** @type {string | undefined} */
				let rename_description = undefined
				if (path.includes(' => ')) {
					rename_description = path
					let renamed = split_rename(path)
					path = renamed.old_path
					new_path = renamed.new_path
				}
				all[path] = {
					path,
					new_path,
					insertions: Number(split[0]),
					deletions: Number(split[1]),
					rename_path: rename_description,
				}
			}
			return all
		}, {}))
}

let hash1 = computed(() =>
	props.commit2 ? props.commit1.hash : `${props.commit1.hash}~1`)
let hash2 = (/** @type {string | undefined} */ filepath) => {
	if (props.commit2)
		return props.commit2.hash
	if (! filepath)
		return props.commit1.hash
	if (props.commit1.stash) {
		let is_creation = file_diffs.value?.find(f => f.path === filepath)?.is_creation
		if (is_creation)
			return `${props.commit1.hash}^3` // stashes are internally represented by a 3way-merge
	}
	return props.commit1.hash
}

watchEffect(async () => {
	file_diffs.value = null
	// so we can see untracked as well
	let get_files_command = props.commit2
		? `-c core.quotepath=false diff --numstat --summary --format="" ${hash1.value} ${hash2()}`
		: props.commit1.stash
			// `diff` doesn't have an --include-untracked
			? `-c core.quotepath=false stash show --include-untracked --numstat --summary --format="" ${props.commit1.hash}`
			: `-c core.quotepath=false show --numstat --summary --format="" ${hash2()}`
	file_diffs.value = git_numstat_summary_to_changes_array(await git(get_files_command))
})

// For a renamed file the old name (file.path) exists only in hash1 and the new
// name (file.new_path) only in hash2, so each side must use its own path — using
// one path for both revisions yields an empty pane on the side where it's absent.
function show_diff(/** @type {FileDiff} */ file) {
	return exchange_message('open-diff', {
		title: `${file.new_path} ${hash1.value} - ${hash2(file.path)}`,
		uris: [
			`${hash1.value}:${file.path}`,
			`${hash2(file.path)}:${file.new_path}`,
		],
	})
}
function show_multi_diff() {
	return exchange_message('open-multi-diff', {
		title: `${hash1.value} - ${hash2()}`,
		uris: (file_diffs.value || []).map(file => [
			`${hash1.value}:${file.path}`,
			`${hash2(file.path)}:${file.new_path}`,
		]),
	})
}
function view_rev(/** @type {FileDiff} */ file) {
	return exchange_message('view-rev', {
		uri: `${hash2(file.path)}:${file.new_path}`,
	})
}

function open_file(/** @type {FileDiff} */ file) {
	return exchange_message('open-file', { uri: file.new_path })
}

function show_file(/** @type {FileDiff} */ file) {
	return trigger_main_refresh({
		custom_log_args: ({ base_log_args }) =>
			`${base_log_args} --follow -- "${file.new_path}"`,
		fetch_stash_refs: false,
	})
}

/**
 * @typedef {{
 *	children: Record<string, TreeNode>
 *	files: FileDiff[]
 *	path: string
 * }} TreeNode
 */

let render_style = state('files-diffs-list-render-style', 'list').ref

// TODO jsx / render function instead
let [TemplateFileChangeDefine, TemplateFileChangeReuse] = createReusableTemplate()
let [TemplateFileActionsDefine, TemplateFileActionsReuse] = createReusableTemplate()
let [TemplateTreeNodeDefine, TemplateTreeNodeReuse] = createReusableTemplate()

let files_as_list = computed(() =>
	file_diffs.value?.map((file) => {
		// Even on Windows, the delimiter of git paths output is forward slash
		let path_arr = (file.rename_path || file.path).split('/')
		let ext = path_arr.at(-1)?.split('.').at(-1) || ''
		// Icons have to be hardcoded because actual theme integration is more or less impossible:
		// https://github.com/microsoft/vscode/issues/183893
		let icon = Object.hasOwn(file_extension_icon_path_mapping, ext)
			? file_extension_icon_path_mapping[/** @type {keyof file_extension_icon_path_mapping} */ (ext)]
			: 'default_file.svg'
		return {
			...file,
			filename: path_arr.at(-1) || '?',
			dir: path_arr.slice(0, -1).join('/'),
			dir_arr: path_arr.slice(0, -1),
			icon_path: './file-icons/' + icon,
		}
	}))
let files_list = computed(() => {
	if (render_style?.value === 'list')
		return files_as_list.value
})
let files_tree = computed(() => {
	if (render_style?.value !== 'tree')
		return
	/** @type {TreeNode} */
	let out = {
		children: {},
		files: [],
		path: 'Changes',
	}
	for (let file of files_as_list.value || []) {
		let curr = out
		for (let dir_seg of file.dir_arr)
			curr = curr.children[dir_seg] ||= {
				children: {},
				files: [],
				path: dir_seg,
			}
		curr.files.push(file)
	}
	// Now all available dir segments have their own entry in the tree, but they
	// should be joined together as much as possible (i.e. when there are no files):
	function unify(/** @type {TreeNode} */ curr) {
		let modified_children = true
		while (modified_children) {
			modified_children = false
			for (let [child_i, child] of Object.entries(curr.children))
				if (! child.files.length) {
					for (let grand_child of Object.values(child.children)) {
						grand_child.path = child.path + ' / ' + grand_child.path
						curr.children[grand_child.path] = grand_child
					}
					delete curr.children[child_i]
					modified_children = true
				} else
					unify(child)
		}
	}
	unify(out)
	return out
})

</script>
<style scoped>
.commit-diff {
	position: relative;
}
.change {
	flex-shrink: 0;
	font-family: monospace;
	font-size: 90%;
}
.change > .count {
	width: 2rem;
}
.filename {
	white-space: pre;
	overflow: hidden;
	text-overflow: ellipsis;
	color: var(--vscode-gitDecoration-modifiedResourceForeground);
	flex-shrink: 0;
}
ul.list > li {
	padding-left: 10px;
	position: relative;
}
ul.list > li .dir {
	font-size: 0.9em;
	opacity: 0.7;
	white-space: pre;
	overflow: hidden;
	text-overflow: ellipsis;
}
.tree-node {
	position: relative;
}
aside.actions {
	position: absolute;
	top: 10px;
	right: 10px;
}
.file-actions {
	display: none;
}
.file-actions > *, .actions > * {
	padding: 2px;
}
.list-row,
.tree-node > summary,
.tree-node > .body > .row {
	height: 20px;
}
.list-row:hover,
.tree-node > summary:hover,
.tree-node > .body > .row:hover {
	background: var(--vscode-list-hoverBackground);
}
.list-row:hover > .file-actions,
.tree-node > summary:hover > .file-actions,
.tree-node > .body > .row:hover > .file-actions {
	display: flex;
}
.tree-node > .body {
	padding-left: 20px;
}
</style>
