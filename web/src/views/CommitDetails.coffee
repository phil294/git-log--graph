import { ref, computed, defineComponent, watchEffect } from 'vue'
import { git, exchange_message } from '../bridge.coffee'
import { commit_actions, stash_actions, branch_actions, tag_actions } from './store.coffee'
import GitActionButton from './GitActionButton.vue'
import RefTip from './RefTip.vue'
``###*
# @typedef {import('./types').Commit} Commit
# @typedef {import('./types').Branch} Branch
###
###* @template T @typedef {import('vue').Ref<T>} Ref ###
###* @template T @typedef {import('vue').ComputedRef<T>} ComputedRef ###

export default defineComponent
	components: { GitActionButton, RefTip }
	emits: ['hash_clicked']
	props:
		commit:
			###* @type {() => Commit} ###
			type: Object
			required: true
	setup: (props) ->
		branch_tips = computed =>
			props.commit.refs.filter (ref) =>
				ref.type == "branch"
		
		tags = computed =>
			props.commit.refs.filter (ref) =>
				ref.type == "tag"
		``###* @type {Ref<string[]>} ###
		tag_details = ref []

		stash = computed =>
			props.commit.refs.find (ref) =>
				ref.type == "stash"
		
		``###* @type {Ref<{filename:string,dir:string,insertions:number,deletions:number}[]>} ###
		changed_files = ref []
		body = ref ''
		watchEffect =>
			get_files_command =
				if stash.value
					# so we can see untracked as well
					"stash show --include-untracked --numstat --format=\"\" #{props.commit.hash}"
				else
					"diff --numstat --format=\"\" #{props.commit.hash} #{props.commit.hash}~1"
			changed_files.value = (try await git get_files_command)
				?.split('\n').map((l) =>
					split = l.split('\t')
					path = split[2].split('/')
					path: split[2]
					filename: path.at(-1) or '?'
					dir: path.slice(0, -1).join('/')
					insertions: Number split[1]
					deletions: Number split[0]) or []

			body.value = await git "show -s --format=\"%b\" #{props.commit.hash}"

			tag_details.value = []
			for tag from tags.value
				details = await git "show --format='' --quiet refs/tags/" + tag.name
				tag_details.value.push details
		
		show_diff = (###* @type string ### filepath) =>
			exchange_message 'open-diff',
				hashes: [props.commit.hash+'~1', props.commit.hash]
				filename: filepath
		view_rev = (###* @type string ### filepath) =>
			exchange_message 'view-rev',
				hash: props.commit.hash
				filename: filepath
		open_file = (###* @type string ### filepath) =>
			exchange_message 'open-file',
				filename: filepath
		_commit_actions = computed =>
			commit_actions(props.commit.hash).value
		_stash_actions = computed =>
			stash_actions(stash.value?.name or '').value
		_branch_actions = computed => (###* @type Branch ### branch) =>
			branch_actions(branch).value
		_tag_actions = computed => (###* @type string ### tag_name) =>
			tag_actions(tag_name).value

		{
			branch_tips
			tags
			tag_details
			stash
			changed_files
			show_diff
			view_rev
			open_file
			body
			commit_actions: _commit_actions
			branch_actions: _branch_actions
			tag_actions: _tag_actions
			stash_actions: _stash_actions
		}