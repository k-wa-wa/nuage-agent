/**
 * @what Custom ESLint rule that requires @what and @why TSDoc tags on every exported
 *       function, class, or arrow-function constant declaration.
 * @why Inline custom rule avoids external dependencies and ensures the "why" context
 *      standard is enforced at the lint stage rather than at review time.
 */

/** @type {import('eslint').Rule.RuleModule} */
const requireWhatWhy = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Require @what and @why TSDoc tags on all exported functions and classes',
      category: 'Best Practices',
    },
    schema: [],
    messages: {
      missingJsdoc: 'Exported declaration is missing a JSDoc comment with @what and @why tags.',
      missingWhat: 'JSDoc comment is missing the @what tag (describe WHAT this does).',
      missingWhy: 'JSDoc comment is missing the @why tag (explain WHY this exists).',
    },
  },

  create(context) {
    const sourceCode = context.sourceCode;

    /**
     * @what Retrieves the immediately-preceding block comment that looks like a JSDoc
     *       comment (starts with `*`) for a given AST node.
     * @why We need to inspect the raw comment text for custom @what / @why tags because
     *      no existing eslint-plugin-jsdoc rule supports arbitrary required tags.
     * @param {import('eslint').Rule.Node} node
     * @returns {import('estree').Comment | null}
     */
    function getJsdocComment(node) {
      // Walk backwards through tokens+comments to find the first block comment
      const tokenBefore = sourceCode.getTokenBefore(node, {
        includeComments: true,
      });
      if (tokenBefore && tokenBefore.type === 'Block' && tokenBefore.value.startsWith('*')) {
        return tokenBefore;
      }
      return null;
    }

    /**
     * @what Determines whether an ExportNamedDeclaration or ExportDefaultDeclaration
     *       wraps a declaration type we care about (function, class, or arrow const).
     * @why We only want to enforce the tags on callable / class exports, not on
     *      re-exports or plain constant values.
     * @param {import('estree').ExportNamedDeclaration | import('estree').ExportDefaultDeclaration} node
     * @returns {boolean}
     */
    function isDocumentableExport(node) {
      const decl = node.declaration;
      if (!decl) return false;
      if (decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') {
        return true;
      }
      if (decl.type === 'VariableDeclaration') {
        return decl.declarations.some(
          (d) =>
            d.init &&
            (d.init.type === 'ArrowFunctionExpression' || d.init.type === 'FunctionExpression'),
        );
      }
      return false;
    }

    /**
     * @what Validates the export node: ensures a JSDoc block exists and contains
     *       both @what and @why tags.
     * @why Central validation logic called for each export visitor so error messages
     *      are consistent and reported on the correct node.
     * @param {import('eslint').Rule.Node} node
     */
    function checkExport(node) {
      if (!isDocumentableExport(node)) return;

      const jsdoc = getJsdocComment(node);

      if (!jsdoc) {
        context.report({ node, messageId: 'missingJsdoc' });
        return;
      }

      const text = jsdoc.value;
      if (!/@what\b/.test(text)) {
        context.report({ node, messageId: 'missingWhat' });
      }
      if (!/@why\b/.test(text)) {
        context.report({ node, messageId: 'missingWhy' });
      }
    }

    return {
      ExportNamedDeclaration: checkExport,
      ExportDefaultDeclaration: checkExport,
    };
  },
};

export default requireWhatWhy;
