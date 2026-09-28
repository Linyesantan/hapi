// Re-export of the shared slash-command catalog so web code has a single
// import site for it.
//
// The two command-name helpers that used to live here
// (findCodexCustomPromptExpansion, findUnsupportedCodexBuiltinSlashCommand)
// plus their local UNSUPPORTED_CODEX_BUILTIN_COMMANDS copy were dead: nothing
// outside their own test file called them, and the copy had drifted to 5
// entries while the enforced list in cli/src/codex/utils/slashCommands.ts
// holds 12. Codex command interception happens in the CLI (which is the only
// path that can translate a command into a Codex RPC call), so the enforced
// list now lives only there.
import {
    getBuiltinSlashCommands,
    mergeSlashCommands,
    isSlashCommandUnavailable,
    filterUnavailableSlashCommands
} from '@hapi/protocol/slashCommands'

export {
    getBuiltinSlashCommands,
    mergeSlashCommands,
    isSlashCommandUnavailable,
    filterUnavailableSlashCommands
}
