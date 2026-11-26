'use strict';
// stripMarkdown(text): turns a model answer into plain text, like the posts of the channel (they have no markup).
// The same function must be used (1) when AI texts are generated for the evaluation and (2) by the bot for its input,
// so that the linter sees the same kind of text on both sides.
function stripMarkdown(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/^```[^\n]*\n?/gm, '')                         // code fences
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')               // "## Heading" -> "Heading"
    .replace(/^[ \t]{0,3}[*-][ \t]+/gm, '• ')          // "- item" / "* item" -> "• item"
    .replace(/\*\*(?=\S)([^*\n]+?)(?<=\S)\*\*/g, '$1')      // **bold**
    .replace(/__(?=\S)([^_\n]+?)(?<=\S)__/g, '$1')          // __bold__
    .replace(/(?<![*\w])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![*\w])/g, '$1') // *italic*
    .replace(/`([^`\n]+)`/g, '$1')                          // `code`
    .replace(/\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g, '$1 ($2)') // [text](url) -> text (url)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

module.exports = { stripMarkdown };
