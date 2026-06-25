const SENSITIVE_KEY_PATTERN =
  /(password|secret|credential|privatekey|private_key|certificatecontent|certcontent|payload|token|authorization|passphrase|keymaterial|binarycontent|content)/i;

const MAX_STRING_LENGTH = 500;

const redactValue = (value) => {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}…[truncated]` : value;
  }

  return "[redacted]";
};

const redactSensitiveFields = (input, depth = 0) => {
  if (depth > 8) {
    return "[redacted-depth-limit]";
  }

  if (Array.isArray(input)) {
    return input.map((entry) => redactSensitiveFields(entry, depth + 1));
  }

  if (!input || typeof input !== "object") {
    return input;
  }

  return Object.entries(input).reduce((acc, [key, value]) => {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      acc[key] = redactValue(value);
      return acc;
    }

    if (value && typeof value === "object") {
      acc[key] = redactSensitiveFields(value, depth + 1);
      return acc;
    }

    acc[key] = value;
    return acc;
  }, {});
};

module.exports = { redactSensitiveFields, SENSITIVE_KEY_PATTERN };
