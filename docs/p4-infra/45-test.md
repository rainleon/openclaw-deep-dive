# 测试

\`\`\`typescript
const AUDIO_TAG_RE = /\[\[\s*audio_as_voice\s*\]\]/gi;
const REPLY_TAG_RE = /\[\[\s*(?:reply_to_current|reply_to\s*:\s*([^\]\n]+))\s*\]\]/gi;

const withoutAudio = text.replace(AUDIO_TAG_RE, "");
const stripped = withoutAudio.replace(REPLY_TAG_RE, "");
\`\`\`
