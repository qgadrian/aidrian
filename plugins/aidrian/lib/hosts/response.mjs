// The tool response shapes hosts share: an object, a JSON string, a content-block array, or `{content: [...]}`.
// A host adapter's `toolResponse` starts here. No dependencies, since every hook loads this file.

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

function parseJson(body) {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function firstJsonBlock(blocks) {
  if (!Array.isArray(blocks)) return undefined;
  for (const block of blocks) {
    if (isObject(block) && block.type === 'text' && typeof block.text === 'string') {
      const json = parseJson(block.text);
      if (json !== undefined) return json;
    }
  }
  return undefined;
}

// The objects a tool response holds, most direct first: the response itself, then the first text block holding JSON.
// The field of the object wins over its blocks. Empty when the response holds no object.
export function responseObjects(response) {
  const parsed = typeof response === 'string' ? parseJson(response) : response;
  const held = firstJsonBlock(Array.isArray(parsed) ? parsed : parsed?.content);
  return [parsed, held].filter(isObject);
}
