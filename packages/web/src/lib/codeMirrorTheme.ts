import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { alpha, theme } from "../components/theme";

/*
 * CodeMirror's look for code blocks: One Dark's editor theme and highlight
 * style, rule for rule, with its colors read from the console's `code*`
 * tokens. The dark palette holds One Dark's own colors, so the dark theme is
 * One Dark exactly; the light palette is a One Light-like set, and the theme
 * follows a switch live because every color is a CSS variable.
 *
 * The theme is registered as dark, which picks CodeMirror's dark base theme
 * (buttons, text fields, tooltip text, special characters) as One Dark does.
 * The rules under LIGHT re-color the parts of that base theme, and One Dark's
 * literal tints, that would not read on a light ground.
 */

const LIGHT = ':root[data-theme="light"] &';

const editorTheme = EditorView.theme(
  {
    "&": {
      color: theme.codeText,
      backgroundColor: theme.codeBg,
    },
    ".cm-content": {
      caretColor: theme.codeCursor,
    },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: theme.codeCursor },
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: theme.codeSelection,
    },
    ".cm-panels": { backgroundColor: theme.codeGutter, color: theme.codeText },
    ".cm-panels.cm-panels-top": { borderBottom: "2px solid black" },
    ".cm-panels.cm-panels-bottom": { borderTop: "2px solid black" },
    ".cm-searchMatch": {
      backgroundColor: "#72a1ff59",
      outline: "1px solid #457dff",
    },
    ".cm-searchMatch.cm-searchMatch-selected": {
      backgroundColor: "#6199ff2f",
    },
    ".cm-activeLine": { backgroundColor: "#6699ff0b" },
    ".cm-selectionMatch": { backgroundColor: "#aafe661a" },
    "&.cm-focused .cm-matchingBracket, &.cm-focused .cm-nonmatchingBracket": {
      backgroundColor: "#bad0f847",
    },
    ".cm-gutters": {
      backgroundColor: theme.codeBg,
      color: theme.codeComment,
      border: "none",
    },
    ".cm-activeLineGutter": {
      backgroundColor: theme.codeLine,
    },
    ".cm-foldPlaceholder": {
      backgroundColor: "transparent",
      border: "none",
      color: "#ddd",
    },
    ".cm-tooltip": {
      border: "none",
      backgroundColor: theme.codeTooltip,
    },
    ".cm-tooltip .cm-tooltip-arrow:before": {
      borderTopColor: "transparent",
      borderBottomColor: "transparent",
    },
    ".cm-tooltip .cm-tooltip-arrow:after": {
      borderTopColor: theme.codeTooltip,
      borderBottomColor: theme.codeTooltip,
    },
    ".cm-tooltip-autocomplete": {
      "& > ul > li[aria-selected]": {
        backgroundColor: theme.codeLine,
        color: theme.codeText,
      },
    },

    [`${LIGHT} .cm-panels.cm-panels-top`]: { borderBottom: `1px solid ${theme.edge}` },
    [`${LIGHT} .cm-panels.cm-panels-bottom`]: { borderTop: `1px solid ${theme.edge}` },
    [`${LIGHT} .cm-searchMatch`]: {
      backgroundColor: alpha(theme.codeCursor, 0x33),
      outline: `1px solid ${alpha(theme.codeCursor, 0x99)}`,
    },
    [`${LIGHT} .cm-searchMatch.cm-searchMatch-selected`]: { backgroundColor: alpha(theme.codeCursor, 0x1f) },
    [`${LIGHT} .cm-activeLine`]: { backgroundColor: alpha(theme.codeCursor, 0x0b) },
    [`${LIGHT} .cm-selectionMatch`]: { backgroundColor: alpha(theme.codeString, 0x26) },
    [`${LIGHT}.cm-focused .cm-matchingBracket, ${LIGHT}.cm-focused .cm-nonmatchingBracket`]: {
      backgroundColor: alpha(theme.codeCursor, 0x33),
    },
    [`${LIGHT} .cm-foldPlaceholder`]: { color: theme.codeComment },
    [`${LIGHT} .cm-tooltip`]: { color: theme.codeText },
    [`${LIGHT} .cm-specialChar`]: { color: theme.codeInvalid },
    [`${LIGHT} .cm-button`]: {
      backgroundImage: `linear-gradient(${theme.surface}, ${theme.raised})`,
      border: `1px solid ${theme.edge}`,
      "&:active": { backgroundImage: `linear-gradient(${theme.raised}, ${theme.surface})` },
    },
    [`${LIGHT} .cm-textfield`]: {
      border: `1px solid ${theme.edge}`,
      backgroundColor: theme.surface,
    },
  },
  { dark: true },
);

const highlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: theme.codeKeyword },
  { tag: [tags.name, tags.deleted, tags.character, tags.propertyName, tags.macroName], color: theme.codeName },
  { tag: [tags.function(tags.variableName), tags.labelName], color: theme.codeFunction },
  { tag: [tags.color, tags.constant(tags.name), tags.standard(tags.name)], color: theme.codeNumber },
  { tag: [tags.definition(tags.name), tags.separator], color: theme.codeText },
  {
    tag: [tags.typeName, tags.className, tags.number, tags.changed, tags.annotation, tags.modifier, tags.self, tags.namespace],
    color: theme.codeType,
  },
  {
    tag: [tags.operator, tags.operatorKeyword, tags.url, tags.escape, tags.regexp, tags.link, tags.special(tags.string)],
    color: theme.codeOperator,
  },
  { tag: [tags.meta, tags.comment], color: theme.codeComment },
  { tag: tags.strong, fontWeight: "bold" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: tags.link, color: theme.codeComment, textDecoration: "underline" },
  { tag: tags.heading, fontWeight: "bold", color: theme.codeName },
  { tag: [tags.atom, tags.bool, tags.special(tags.variableName)], color: theme.codeNumber },
  { tag: [tags.processingInstruction, tags.string, tags.inserted], color: theme.codeString },
  { tag: tags.invalid, color: theme.codeInvalid },
]);

/** The editor theme and highlight style together, as one extension. */
export const codeMirrorTheme = [editorTheme, syntaxHighlighting(highlightStyle)];
