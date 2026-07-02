<template>
	<div v-context-menu="context_menu_provider" v-drag="drag" v-drop="drop" class="ref-container" :style="container_style" :class="container_class" @dblclick="dblclick">
		<span class="ref-icon">
			<i :class="['codicon', ref_icon_class]" />
		</span>
		<span class="ref-separator" />
		<div class="ref-tip-name">
			{{ git_ref.display_name }}
			<template v-if="branch?.remote_names_group">
				<span v-for="remote_name of branch.remote_names_group" :key="remote_name" class="remote-name-group-entry"> + {{ remote_name }}</span>
			</template>
		</div>
		<span v-if="show_buttons" class="ref-separator" />
		<span v-if="show_buttons" class="actions-menu">
			<button class="ellipsis" title="Actions">⋯</button>
		</span>
	</div>
</template>
<script setup>
import { computed } from 'vue'
import { combine_branches, selected_git_action, show_branch } from '../data/store'
import { head_branch } from '../data/store/repo'
import { branch_actions, stash_actions, tag_actions } from '../data/store/actions'
import vDrag from '../directives/drag'
import vDrop from '../directives/drop'
import vContextMenu from '../directives/context-menu'

let props = defineProps({
	git_ref: {
		/** @type {Vue.PropType<GitRef>} */
		type: Object,
		required: true,
	},
	commit: {
		/** @type {Vue.PropType<Commit>} */
		type: Object,
		default: null,
	},
	show_buttons: {
		type: Boolean,
		default: false,
	},
})

let branch = computed(() => {
	if (is_branch(props.git_ref))
		return props.git_ref
	else
		return null
})

let ref_icon_class = computed(() => {
	if (props.git_ref.type === 'tag')
		return 'codicon-tag'
	if (props.git_ref.type === 'stash')
		return 'codicon-archive'
	return 'codicon-git-branch'
})

function to_context_menu_entries(/** @type {GitAction[]} */ actions) {
	return actions.map((action) => ({
		label: action.title,
		icon: action.icon,
		action() {
			selected_git_action.value = action
		},
	}))
}
let is_head = computed(() => props.git_ref.id === head_branch.value)

let container_style = computed(() => ({
	color: props.git_ref.color,
	border: is_head.value
		? `2px solid ${props.git_ref.color}`
		: '1px solid var(--vscode-editorWidget-border)',
}))

let container_class = computed(() => ({
	head: is_head.value,
	branch: !! branch.value,
	inferred: !! branch.value?.inferred,
}))
let drag = computed(() => {
	if (branch.value)
		return props.git_ref.display_name
	return undefined
})
function drop(/** @type {import('../directives/drop').DropCallbackPayload} */ event) {
	if (! branch.value)
		return
	let source_branch_display_name = event.data
	if (typeof source_branch_display_name !== 'string')
		return
	return combine_branches(source_branch_display_name, props.git_ref.display_name)
}
let context_menu_provider = computed(() => () => {
	if (branch.value)
		return to_context_menu_entries(branch_actions(branch.value).value)
			.concat({
				label: () => Promise.resolve('Show'),
				icon: 'eye',
				action() {
					if (branch.value)
						show_branch(branch.value)
				},
			})
	else if (props.git_ref.type === 'stash' && props.commit)
		return to_context_menu_entries(stash_actions(props.git_ref.name).value)
	else if (props.git_ref.type === 'tag')
		return to_context_menu_entries(tag_actions(props.git_ref.name).value)
	return undefined
})
function dblclick() {
	if (! branch.value)
		return
	// First action is currently always commit
	selected_git_action.value = branch_actions(branch.value).value[0] || null
}
</script>
<style scoped>
.ref-container {
	display: inline-flex;
	align-items: center;
	border-radius: 5px;
	background: var(--vscode-editor-background);
	overflow: hidden;
	max-width: 350px;
	cursor: default;
}
.ref-container.head,
.ref-container.branch {
	cursor: move;
}
.ref-container:hover {
	max-width: unset;
}
.ref-icon {
	display: flex;
	align-items: center;
	justify-content: center;
	padding: 0 6px;
	height: 100%;
	color: var(--vscode-foreground);
}
.ref-icon .codicon {
	font-size: 12px;
}
.ref-separator {
	width: 1px;
	height: 16px;
	background-color: var(--vscode-editorWidget-border);
	align-self: center;
}
.ref-tip-name {
	background: transparent;
	font-weight: bold;
	display: inline-block;
	padding: 1px 4px;
	white-space: pre;
	overflow: hidden;
	text-overflow: ellipsis;
}
.ref-container.head .ref-tip-name:after {
	content: ' (HEAD)';
	color: var(--vscode-editor-compositionBorder);
}
.ref-container.dragenter {
	background: var(--vscode-list-hoverBackground) !important;
	color: #f00 !important;
}
.ref-container.inferred {
	background: rgba(0, 0, 0, 0.3);
	.vscode-light &, .vscode-high-contrast-light & {
		background: rgba(255, 255, 255, 1);
	};
	opacity: 0.8;
	font-weight: normal;
}
.ref-container.inferred .ref-tip-name {
	font-weight: normal;
}
.ref-container.branch.inferred:hover {
	opacity: unset;
}
.remote-name-group-entry {
	color: var(--vscode-editor-compositionBorder);
}
.actions-menu {
	display: inline-flex;
	align-items: stretch;
}
.ellipsis {
	cursor: pointer;
	border: none;
	background: transparent;
	color: inherit;
	padding: 0 6px;
	display: inline-flex;
	align-items: center;
	line-height: 1;
	height: 100%;
	vertical-align: middle;
	font-size: inherit;
}
.ellipsis:hover {
	background: var(--vscode-list-hoverBackground);
}
</style>
