import { ref, computed, onMounted, onUnmounted, useTemplateRef } from 'vue'
import { branches } from './store.js'

export default {
	emit: ['branch_selected'],
	setup() {
		let details_ref = /** @type {Readonly<Vue.ShallowRef<HTMLDetailsElement|null>>} */ (useTemplateRef('details_ref')) // eslint-disable-line no-extra-parens
		let txt_filter = ref('')
		let filtered_branches = computed(() => {
			if (! txt_filter.value)
				return branches.value
			else
				return branches.value.filter((branch) =>
					branch.id.toLowerCase().includes(txt_filter.value.toLowerCase()))
		})
		function on_mouse_up(/** @type {MouseEvent} */ event) {
			if (! (event.target instanceof Element) ||
				event.target.parentElement?.getAttribute('id') !== 'show-all-branches' &&
				! event.target.classList.contains('ref-tip') &&
				! event.target.classList.contains('filter') &&
				! event.target.querySelector('.ref-tip') &&
				! event.target.parentElement?.classList.contains('context-menu-wrapper'))
				details_ref.value?.removeAttribute('open')
		}
		onMounted(() =>
			document.addEventListener('mouseup', on_mouse_up))
		onUnmounted(() =>
			document.removeEventListener('mouseup', on_mouse_up))
		return {
			filtered_branches,
			txt_filter,
			details_ref,
		}
	},
}
