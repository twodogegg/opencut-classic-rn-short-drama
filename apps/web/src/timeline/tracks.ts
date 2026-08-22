import type { TrackType } from "@/timeline";

export const DEFAULT_TRACK_NAMES: Record<TrackType, string> = {
	video: "视频轨道",
	text: "文字轨道",
	audio: "音频轨道",
	graphic: "图形轨道",
	effect: "特效轨道",
} as const;
