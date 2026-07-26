/**
 * Complexity Router Type Definitions
 * Mirrors the AnalyzerConfig shape exchanged with /governance/complexity-analyzer-config.
 */

export interface TierBoundaries {
	simple_medium: number;
	medium_complex: number;
	complex_reasoning: number;
}

export interface EditableKeywordConfig {
	code_keywords: string[];
	reasoning_keywords: string[];
	technical_keywords: string[];
	simple_keywords: string[];
}

export interface AnalyzerConfig {
	tier_boundaries: TierBoundaries;
	keywords: EditableKeywordConfig;
}

export type KeywordListKey = keyof EditableKeywordConfig;

export const COMPLEXITY_TIER_VALUES = ["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"] as const;

export const KEYWORD_LIST_DEFINITIONS: Array<{
	key: KeywordListKey;
	label: string;
	description: string;
}> = [
	{
		key: "simple_keywords",
		label: "简单词",
		description: "偏简单档：打招呼、闲聊、一眼能答的问题。",
	},
	{
		key: "code_keywords",
		label: "代码词",
		description: "有代码、调试、写程序的信号，分数会抬高。",
	},
	{
		key: "technical_keywords",
		label: "技术词",
		description: "架构、运维、基础设施等词，分数会抬高。",
	},
	{
		key: "reasoning_keywords",
		label: "深度思考词",
		description: "强推理触发词。命中后可能直接升到「深度思考」档。",
	},
];

export const DEFAULT_TIER_BOUNDARIES: TierBoundaries = {
	simple_medium: 0.15,
	medium_complex: 0.35,
	complex_reasoning: 0.6,
};