import { computed, nextTick, shallowRef } from 'vue'
import { add_push_listener, exchange_message } from '../bridge'

/** @typedef {import('../../../src/state').StateKey} StateKey */
/**
 * @template {StateKey} K
 * @typedef {import('../../../src/state').StateType<K>} StateType
 */
/**
 * @template {StateKey} K
 * @typedef {{
 *	ref: Vue.WritableComputedRef<NonNullable<StateType<K>>>
 *	reload: () => Promise<void>
 *	_internal: Vue.ShallowRef<NonNullable<StateType<K>>>
 * }} State
 */

/** @type {{[key in StateKey]?: State<key>}} */
let _states = {}
add_push_listener('state-update', (
	/**
	 * @template {StateKey} K
	 * @type {{data?: {key: K, value: NonNullable<StateType<K>>}}}
	 */
	msg) => {
	let { data: { key, value } = {} } = msg
	if (key && value && _states[key]) {
		_states[key]._internal.value = value // Skip the unnecessary roundtrip to backend
		_states[key].ref.value = value
	}
})
/**
 * This utility returns a `WritableComputed` that will persist its state or react to changes on the
 * backend somehow. The caller doesn't know where it's stored though, this is up to extension.js
 * to decide based on the *key*.
 * @template {StateKey} K
 * @param {K} key
 * @param {NonNullable<StateType<K>>} default_value
 * @param {() => void} on_load=
 * @param {{ write_only?: boolean }} opt
 */
let state = (key, default_value, on_load = () => {}, { write_only } = {}) => {
	/** @type {State<K>|undefined} */
	let ret = _states[key]
	if (ret) {
		nextTick()
			.then(on_load)
		return ret
	}
	// shallow because type error https://github.com/vuejs/composition-api/issues/483
	// TODO: this type cast shouldn't be necessary
	let _internal = /** @type {Vue.ShallowRef<NonNullable<StateType<K>>>} */ (shallowRef(default_value))
	ret = {
		ref: computed({
			get: () => _internal.value,
			set(value) {
				if (_internal.value !== value)
					exchange_message('set-state', { key, value })
				_internal.value = value
			},
		}),
		reload: async () => {
			_internal.value = default_value
			let stored = await exchange_message('get-state', key)
			if (stored != null) {
				if (typeof stored !== 'string' && typeof default_value === 'string') {
					console.warn(`backend value for state '${key}' should be string but is ${typeof stored}. resetting to default value.`, stored)
					stored = default_value
				}
				_internal.value = stored
			}
		},
		_internal,
	}
	// @ts-ignore // TODO:
	_states[key] = ret;
	(async () => {
		if (! write_only) {
			await ret.reload()
			await nextTick()
		}
		on_load?.()
	})()
	return ret
}

export default state

export let refresh_repo_states = () => {
	// TODO: import keys of static_states and iterate over type=='repo' here
	for (let key of /** @type {const} */ (['repo:action-history', 'repo:selected-commits-hashes']))
		_states[key]?.reload()
}
