import type { Rule } from 'eslint';

/**
 * @what Custom ESLint rule that requires @what and @why TSDoc tags on every exported
 *       function/class declaration, every top-level non-exported function/class/variable holding functions,
 *       AND every class method (public or private).
 * @why Inline custom rule avoids external dependencies and ensures the "why" context
 *      standard is enforced at the lint stage rather than at review time.
 */
const requireWhatWhy: Rule.RuleModule = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Require @what and @why TSDoc tags on exported functions/classes, top-level non-exported functions/classes, and all class methods',
    },
    schema: [],
    messages: {
      missingJsdoc: 'Declaration is missing a JSDoc comment with @what and @why tags.',
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
     */
    function getJsdocComment(node: Rule.Node) {
      const tokenBefore = sourceCode.getTokenBefore(node, {
        includeComments: true,
      });
      if (tokenBefore?.type === 'Block' && tokenBefore.value.startsWith('*')) {
        return tokenBefore;
      }
      return null;
    }

    /**
     * @what Validates a node: ensures a JSDoc block exists immediately before it
     *       and that the block contains both @what and @why tags.
     * @why Central validation logic shared by export-level and method-level checks
     *      so error messages are consistent and reported on the correct node.
     */
    function checkNode(node: Rule.Node) {
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

    /**
     * @what Determines whether an ExportNamedDeclaration or ExportDefaultDeclaration
     *       wraps a declaration type we care about (function, class, or arrow const).
     * @why We only want to enforce the tags on callable / class exports, not on
     *      re-exports or plain constant values.
     */
    function isDocumentableExport(node: Rule.Node): boolean {
      const exportNode = node as unknown as {
        declaration?: {
          type: string;
          declarations?: {
            init?: {
              type: string;
            };
          }[];
        };
      };
      const decl = exportNode.declaration;
      if (!decl) {
        return false;
      }
      if (decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') {
        return true;
      }
      if (decl.type === 'VariableDeclaration') {
        return (
          decl.declarations?.some(
            (d) =>
              d.init &&
              (d.init.type === 'ArrowFunctionExpression' || d.init.type === 'FunctionExpression'),
          ) ?? false
        );
      }
      return false;
    }

    /**
     * @what Checks exported top-level declarations (functions, classes, arrow consts).
     * @why Enforces the @what/@why contract on the public API surface of each module.
     */
    function checkExport(node: Rule.Node) {
      if (!isDocumentableExport(node)) {
        return;
      }
      checkNode(node);
    }

    /**
     * @what Checks non-exported top-level declarations (functions, classes, variables holding functions).
     * @why Enforces the @what/@why contract on module-local top-level declarations to keep script entrypoints and helper modules well-documented.
     */
    function checkNonExportedDeclaration(node: Rule.Node) {
      if (node.parent?.type !== 'Program') {
        return;
      }

      if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') {
        checkNode(node);
      } else if (node.type === 'VariableDeclaration') {
        const varNode = node as unknown as {
          declarations?: {
            init?: {
              type: string;
            };
          }[];
        };
        const hasFunction = varNode.declarations?.some(
          (d) =>
            d.init &&
            (d.init.type === 'ArrowFunctionExpression' || d.init.type === 'FunctionExpression'),
        );
        if (hasFunction) {
          checkNode(node);
        }
      }
    }

    /**
     * @what Checks every MethodDefinition inside a class body (constructor excluded).
     * @why Class methods carry non-trivial logic and design decisions regardless of
     *      whether they are public or private, so they must also be documented with
     *      @what and @why to keep the codebase self-explanatory.
     */
    function checkMethod(node: Rule.Node) {
      const methodNode = node as unknown as { kind: string };
      // Skip constructors — they are self-explanatory by convention
      if (methodNode.kind === 'constructor') {
        return;
      }
      checkNode(node);
    }

    return {
      ExportNamedDeclaration: checkExport,
      ExportDefaultDeclaration: checkExport,
      FunctionDeclaration: checkNonExportedDeclaration,
      ClassDeclaration: checkNonExportedDeclaration,
      VariableDeclaration: checkNonExportedDeclaration,
      MethodDefinition: checkMethod,
    };
  },
};

export default requireWhatWhy;
