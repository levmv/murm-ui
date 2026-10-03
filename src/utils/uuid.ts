/** Generates a UUIDv7 with a millisecond timestamp and random bits. */
export function uuidv7(): string {
	// The first 48 bits encode the timestamp.
	const timestampHex = Date.now().toString(16).padStart(12, "0");

	const bytes = new Uint8Array(10);
	crypto.getRandomValues(bytes);

	// Set the version nibble to 7 and the variant's high bits to 10.
	const versionGroup =
		(0x70 | (bytes[0] & 0x0f)).toString(16).padStart(2, "0") + bytes[1].toString(16).padStart(2, "0");
	const variantGroup =
		(0x80 | (bytes[2] & 0x3f)).toString(16).padStart(2, "0") + bytes[3].toString(16).padStart(2, "0");

	let randomTail = "";
	for (let i = 4; i < 10; i++) {
		randomTail += bytes[i].toString(16).padStart(2, "0");
	}

	return `${timestampHex.substring(0, 8)}-${timestampHex.substring(8)}-${versionGroup}-${variantGroup}-${randomTail}`;
}
