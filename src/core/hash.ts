import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

/**
 * SHA-256 of the text's UTF-8 bytes, as hex. Synchronous because Vault.process needs a
 * synchronous callback; Web Crypto's digest is async.
 */
export function fingerprint(text: string): string {
	return bytesToHex(sha256(utf8ToBytes(text)));
}
