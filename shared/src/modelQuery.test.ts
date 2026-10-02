import { describe, it, expect } from 'bun:test';
import { filterModelCatalog, parseModelQuery } from './modelQuery';

const model = (modelId: string, name?: string) => (name ? { modelId, name } : { modelId });

const catalog = [
    model('opencode/space-bunny-free', 'OpenCode Zen/Space Bunny Free'),
    model('agy/gemini-3.8-flash-tiered', 'Antigravity 反代/Gemini 3.8 Flash Tiered'),
    model('kuaipao/deepseek-v4.1-flash-特价', '快跑特价/DeepSeek V4.1 Flash 特价'),
    model('kimi/kimi-k2-thinking'),
    model('tokenrhythm2/glm-5.3')
];

describe('filterModelCatalog', () => {
    it('matches on modelId substring and on display name', () => {
        expect(filterModelCatalog(catalog, 'glm').map(m => m.modelId)).toEqual(['tokenrhythm2/glm-5.3']);
        expect(filterModelCatalog(catalog, '反代').map(m => m.modelId)).toEqual(['agy/gemini-3.8-flash-tiered']);
    });

    it('matches loosely as a subsequence, case-insensitively', () => {
        expect(filterModelCatalog(catalog, 'k2think').map(m => m.modelId)).toEqual(['kimi/kimi-k2-thinking']);
        expect(filterModelCatalog(catalog, 'SPACEBUNNY').map(m => m.modelId)).toEqual(['opencode/space-bunny-free']);
    });

    it('ranks exact matches ahead of substring and subsequence matches', () => {
        const ranked = filterModelCatalog(catalog, 'kimi').map(m => m.modelId);
        expect(ranked[0]).toBe('kimi/kimi-k2-thinking');
    });

    it('preserves catalog order for an empty query', () => {
        expect(filterModelCatalog(catalog, '')).toHaveLength(catalog.length);
        expect(filterModelCatalog(catalog, '  ').map(m => m.modelId)).toEqual(catalog.map(m => m.modelId));
    });

    it('returns nothing when the query matches no candidate', () => {
        expect(filterModelCatalog(catalog, 'zzzznope')).toEqual([]);
    });
});

describe('parseModelQuery', () => {
    it('recognizes /model with no argument, spaces, and trailing text', () => {
        expect(parseModelQuery('/model')).toEqual({ keyword: '' });
        expect(parseModelQuery('/model glm')).toEqual({ keyword: 'glm' });
        expect(parseModelQuery('/MODEL  kimi  ')).toEqual({ keyword: 'kimi' });
    });

    it('leaves other slash commands alone', () => {
        expect(parseModelQuery('/modeling')).toBeNull();
        expect(parseModelQuery('/models glm')).toBeNull();
        expect(parseModelQuery('/help')).toBeNull();
        expect(parseModelQuery('hello /model x')).toBeNull();
    });
});
