import { describe, it, expect } from 'vitest';
import type { OpencodeModelSummary } from '@hapi/protocol/apiTypes';
import { resolveModelQuery, MODEL_PICKER_LIMIT } from './modelPicker';

const model = (modelId: string, name?: string): OpencodeModelSummary => (name ? { modelId, name } : { modelId });

const catalog: OpencodeModelSummary[] = [
    model('opencode/space-bunny-free', 'OpenCode Zen/Space Bunny Free'),
    model('agy/gemini-3.8-flash-tiered', 'Antigravity 反代/Gemini 3.8 Flash Tiered'),
    model('kuaipao/deepseek-v4.1-flash-特价', '快跑特价/DeepSeek V4.1 Flash 特价'),
    model('kimi/kimi-k2-thinking'),
    model('tokenrhythm2/glm-5.3')
];

describe('resolveModelQuery', () => {
    it('lists the catalog with the current model flagged', () => {
        const result = resolveModelQuery({
            query: '',
            models: catalog,
            currentModelId: 'kimi/kimi-k2-thinking',
            sessionModel: null
        });
        expect(result.kind).toBe('list');
        const message = (result as { message: string }).message;
        expect(message).toContain('current: `kimi/kimi-k2-thinking`');
        expect(message).toContain('1. `opencode/space-bunny-free`');
        expect(message).toContain('4. `kimi/kimi-k2-thinking`');
        expect(message).toContain('← current');
    });

    it('truncates long catalogs and says how many were hidden', () => {
        const many = Array.from({ length: MODEL_PICKER_LIMIT + 3 }, (_, i) => model(`p/model-${i}`));
        const result = resolveModelQuery({ query: 'model', models: many, currentModelId: null, sessionModel: null });
        const message = (result as { message: string }).message;
        expect(message).toContain(`…3 more matches.`);
        expect(message).not.toContain(`model-${MODEL_PICKER_LIMIT + 2}`);
    });

    it('prefers the explicit session model over the probed default when reporting', () => {
        const result = resolveModelQuery({
            query: '',
            models: catalog,
            currentModelId: 'opencode/space-bunny-free',
            sessionModel: 'tokenrhythm2/glm-5.3'
        });
        const message = (result as { message: string }).message;
        expect(message).toContain('current: `tokenrhythm2/glm-5.3`');
    });

    it('sets a model from an exact id', () => {
        expect(resolveModelQuery({
            query: 'tokenrhythm2/glm-5.3',
            models: catalog,
            currentModelId: null,
            sessionModel: null
        })).toEqual({ kind: 'set', model: 'tokenrhythm2/glm-5.3', message: 'OpenCode model set to tokenrhythm2/glm-5.3' });
    });

    it('sets a model from a numbered pick', () => {
        expect(resolveModelQuery({
            query: '2',
            models: catalog,
            currentModelId: null,
            sessionModel: null
        })).toMatchObject({ kind: 'set', model: 'agy/gemini-3.8-flash-tiered' });
    });

    it('re-lists with a warning when the numbered pick is out of range', () => {
        const result = resolveModelQuery({ query: '99', models: catalog, currentModelId: null, sessionModel: null });
        expect(result.kind).toBe('list');
        expect((result as { message: string }).message).toContain('No model #99.');
    });

    it('clears the model for default/auto without touching the catalog', () => {
        for (const query of ['default', 'AUTO', ' default ']) {
            expect(resolveModelQuery({ query, models: [], currentModelId: null, sessionModel: 'x' }))
                .toEqual({ kind: 'set', model: null, message: 'OpenCode model set to default' });
        }
    });

    it('falls back to a filtered list when a non-exact query is not a pick', () => {
        const result = resolveModelQuery({ query: 'deepseek', models: catalog, currentModelId: null, sessionModel: null });
        expect(result.kind).toBe('list');
        const message = (result as { message: string }).message;
        expect(message).toContain('kuaipao/deepseek-v4.1-flash-特价');
        expect(message).not.toContain('kimi/kimi-k2-thinking');
    });

    it('reports no match instead of silently keeping the old model', () => {
        const result = resolveModelQuery({ query: 'zzzznope', models: catalog, currentModelId: null, sessionModel: null });
        expect(result.kind).toBe('list');
        expect((result as { message: string }).message).toContain('No model matches `zzzznope`.');
    });
});
