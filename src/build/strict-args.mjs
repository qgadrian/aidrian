export const parseStrictOptions = (args, specification) => {
  const values = {};
  const seen = new Set();

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const option = specification[flag];
    if (!option) throw new Error(`unknown argument ${flag}`);
    if (seen.has(flag)) throw new Error(`duplicate argument ${flag}`);
    seen.add(flag);

    if (option.type === 'boolean') {
      values[option.name] = true;
      continue;
    }

    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    values[option.name] = value;
    index += 1;
  }

  for (const [flag, option] of Object.entries(specification)) {
    if (option.required && !seen.has(flag)) throw new Error(`${flag} is required`);
    if (!seen.has(flag) && Object.hasOwn(option, 'default')) values[option.name] = option.default;
  }

  return values;
};
