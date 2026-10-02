import type { OpencodeModelSummary } from '@hapi/protocol/apiTypes';
import { filterModelCatalog, MODEL_QUERY_LIMIT } from '@hapi/protocol/modelQuery';

export const MODEL_PICKER_LIMIT = MODEL_QUERY_LIMIT;

export type ModelPickerResolution =
    | { kind: 'list'; message: string }
    | { kind: 'set'; model: string | null; message: string };

export const filterModels = filterModelCatalog<OpencodeModelSummary>;

function formatList(
    entries: readonly OpencodeModelSummary[],
    currentModelId: string | null | undefined,
    query: string,
    total: number
): string {
    const header = ['**OpenCode model**', '', `current: \`${currentModelId ?? 'default'}\``];
    if (!entries.length) {
        return [...header, '', query
            ? `No model matches \`${query}\`.`
            : 'No models available in this directory.'].join('\n');
    }
    const lines = entries.map((entry, index) => {
        const marker = entry.modelId === currentModelId ? ' ← current' : '';
        const name = entry.name && entry.name !== entry.modelId ? ` (${entry.name})` : '';
        return `${index + 1}. \`${entry.modelId}\`${name}${marker}`;
    });
    const hidden = total - entries.length;
    const suffix = hidden > 0
        ? `…${hidden} more match${hidden === 1 ? '' : 'es'}.`
        : '';
    const hint = 'Filter with `/model <keyword>`, or pick with `/model <number>`. Use `/model default` to reset.';
    return [...header, '', ...lines, '', [suffix, hint].filter(Boolean).join(' ')].join('\n');
}

/**
 * Resolve `/model` against the freshly probed catalog. A bare `/model` lists the
 * catalog, `/model <keyword>` filters it, `/model <number>` picks from the same
 * numbered list, and `default`/`auto` still clears the explicit model.
 */
export function resolveModelQuery(options: {
    query: string;
    models: readonly OpencodeModelSummary[];
    currentModelId: string | null;
    sessionModel: string | null;
}): ModelPickerResolution {
    const { query, models, currentModelId, sessionModel } = options;
    const raw = query.trim();
    const effectiveCurrent = sessionModel ?? currentModelId ?? null;

    if (raw && ['default', 'auto'].includes(raw.toLowerCase())) {
        return { kind: 'set', model: null, message: 'OpenCode model set to default' };
    }

    const fullList = () => formatList(
        models.slice(0, MODEL_PICKER_LIMIT),
        effectiveCurrent,
        '',
        models.length
    );

    if (!raw) {
        return { kind: 'list', message: fullList() };
    }

    const indexMatch = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : null;
    if (indexMatch !== null) {
        const target = models[indexMatch - 1];
        if (!target) {
            return { kind: 'list', message: `${fullList()}\n\nNo model #${indexMatch}.` };
        }
        return { kind: 'set', model: target.modelId, message: `OpenCode model set to ${target.modelId}` };
    }

    const exact = models.find(entry => entry.modelId.toLowerCase() === raw.toLowerCase());
    if (exact) {
        return { kind: 'set', model: exact.modelId, message: `OpenCode model set to ${exact.modelId}` };
    }

    const matches = filterModels(models, raw);
    return {
        kind: 'list',
        message: formatList(matches.slice(0, MODEL_PICKER_LIMIT), effectiveCurrent, raw, matches.length)
    };
}
