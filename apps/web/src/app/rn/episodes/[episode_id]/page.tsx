"use client";

import { useParams } from "next/navigation";
import Editor from "@/app/editor/[project_id]/page";

export default function EpisodeEditor() {
	const params = useParams();
	const episodeId = Number(params.episode_id);
	if (!Number.isInteger(episodeId) || episodeId < 1) return null;
	return <Editor episodeId={episodeId} />;
}
