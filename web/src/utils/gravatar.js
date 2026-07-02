import { sha256_hash } from '../bridge'
import { as_object_or_null } from './is-object'

/** localStorage persisted */
class AvatarCache {
	constructor() {
		this.cache_key = 'gitlg_avatar_cache'
		this.expiry_days = 7
		/** @type {Record<string, null | {data: string | Promise<string | null>, timestamp: number}>} */
		// @ts-expect-error fully validating localstorage data is too much hassle
		this.cache = as_object_or_null(JSON.parse(localStorage.getItem(this.cache_key) ?? 'null')) ?? {}
	}
	#write_cache() {
		// Only not non-nulls are stored so http errors are retried at next extension reload
		localStorage.setItem(this.cache_key, JSON.stringify(Object.fromEntries(Object.entries(this.cache).filter(([_email, value]) =>
			value && ! (value.data instanceof Promise)))))
	}
	/** @returns base64 image data or null if prior request failed or undefined if not yet cached */
	get(/** @type {string} */ email) {
		return this.cache[email] ? this.cache[email].data : this.cache[email]
	}
	set(/** @type {string} */ email, /** @type {string | null | Promise<string | null>} */ value) {
		this.cache[email] = value === null
			? value : {
				data: value,
				timestamp: Date.now(),
			}
		this.#write_cache()
	}
	// TODO: test
	/** Clear expired entries from cache */
	cleanup() {
		let now = Date.now()
		let expiry_time = this.expiry_days * 24 * 60 * 60 * 1000
		this.cache = Object.fromEntries(Object.entries(this.cache).filter(([_hash, value]) =>
			value?.timestamp != null && now < value.timestamp + expiry_time))
		this.#write_cache()
	}
}

let avatar_cache = new AvatarCache()

// TODO: separate file
async function download_as_base64(/** @type {string} */ url) {
	const response = await fetch(url)
	if (! response.ok)
		throw new Error(`Failed to fetch url, status ${String(response.status)}`)
	// Throws on Chrome<140 / VSCode<Nov2025
	// `toBase64` is newer than the TS lib types know about (see comment above)
	return /** @type {{ toBase64(): string }} */ (/** @type {unknown} */ (new Uint8Array(await (await response.blob()).arrayBuffer()))).toBase64()
}

export async function get_avatar(/** @type {string} */ email_unsafe) {
	let email = email_unsafe.trim().toLowerCase()
	if (! email)
		return null

	let cached = avatar_cache.get(email)
	if (cached !== undefined)
		return cached

	let { promise, resolve } = Promise.withResolvers()
	avatar_cache.set(email, promise)
	let hash = await sha256_hash(email)
	let gravatar_url = `https://www.gravatar.com/avatar/${hash}?s=32&d=identicon&r=pg`
	let data_or_null = await download_as_base64(gravatar_url)
		.then(base64 => `data:image/png;base64,${base64}`)
		.catch((/** @type {unknown} */ e) => {
			console.warn(gravatar_url, e)
			return null
		})
	avatar_cache.set(email, data_or_null)
	resolve(data_or_null)
	return data_or_null
}

avatar_cache.cleanup()
