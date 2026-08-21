"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { EditorCore } from "@/core";
import { useEditor } from "@/editor/use-editor";
import { useKeybindingsListener } from "@/actions/use-keybindings";
import { useKeybindingsStore } from "@/actions/keybindings-store";
import { useTimelineStore } from "@/timeline/timeline-store";
import { useEditorActions } from "@/actions/use-editor-actions";
import { loadFontAtlas } from "@/fonts/google-fonts";
import {
	initializeGpuRenderer,
	isGpuAvailable,
} from "@/services/renderer/gpu-renderer";

interface EditorProviderProps {
	projectId: string;
	episodeId?: number;
	children: React.ReactNode;
}

export function EditorProvider({ projectId, episodeId, children }: EditorProviderProps) {
	const activeProject = useEditor((e) => e.project.getActiveOrNull());
	const router = useRouter();
	const [isLoading, setIsLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const { setLoadingProject } = useKeybindingsStore();

	useEffect(() => {
		setLoadingProject(isLoading);
	}, [isLoading, setLoadingProject]);

	useEffect(() => {
		let cancelled = false;
		const editor = EditorCore.getInstance();

		const loadProject = async () => {
			try {
				setIsLoading(true);
				await initializeGpuRenderer();
				editor.renderer.setDegraded(!isGpuAvailable());
				if (episodeId) {
					await loadEpisodeProject({ editor, episodeId });
				} else {
					editor.project.setExternalSaveHandler({ handler: null });
					await editor.project.loadProject({ id: projectId });
				}

				if (cancelled) return;

				setIsLoading(false);
				loadFontAtlas();
			} catch (err) {
				if (cancelled) return;

				const isNotFound =
					err instanceof Error &&
					(err.message.includes("not found") ||
						err.message.includes("does not exist"));

				if (isNotFound) {
					try {
						const newProjectId = await editor.project.createNewProject({
							name: "Untitled Project",
						});
						router.replace(`/editor/${newProjectId}`);
					} catch (_createErr) {
						setError("Failed to create project");
						setIsLoading(false);
					}
				} else {
					const wasmPanic = (window as Window & { __wasmPanic?: string })
						.__wasmPanic;
					if (wasmPanic) {
						delete (window as Window & { __wasmPanic?: string }).__wasmPanic;
						setError(wasmPanic);
					} else {
						setError(
							err instanceof Error ? err.message : "Failed to load project",
						);
					}
					setIsLoading(false);
				}
			}
		};

		loadProject();

		return () => {
			cancelled = true;
		};
	}, [episodeId, projectId, router]);

	if (error) {
		return (
			<div className="bg-background flex h-screen w-screen items-center justify-center">
				<div className="flex flex-col items-center gap-4">
					<p className="text-destructive text-sm">{error}</p>
				</div>
			</div>
		);
	}

	if (isLoading) {
		return (
			<div className="bg-background flex h-screen w-screen items-center justify-center">
				<div className="flex flex-col items-center gap-4">
					<Loader2 className="text-muted-foreground size-8 animate-spin" />
					<p className="text-muted-foreground text-sm">Loading project...</p>
				</div>
			</div>
		);
	}

	if (!activeProject) {
		return (
			<div className="bg-background flex h-screen w-screen items-center justify-center">
				<div className="flex flex-col items-center gap-4">
					<Loader2 className="text-muted-foreground size-8 animate-spin" />
					<p className="text-muted-foreground text-sm">Exiting project...</p>
				</div>
			</div>
		);
	}

	return (
		<>
			<EditorRuntimeBindings />
			{children}
		</>
	);
}

type RemoteMedia = {
	media_id: string;
	name: string;
	type: "video" | "audio" | "image";
	url: string;
	mime_type: string;
	size: number;
	duration: number;
	width?: number;
	height?: number;
};

type RemoteProjectResponse = {
	project: Record<string, unknown>;
	revision: number;
	media: RemoteMedia[];
	media_bindings: Array<{ media_id: string; storyboard_id: number; video_work_id: number }>;
	is_initialized: boolean;
};

async function loadEpisodeProject({ editor, episodeId }: { editor: EditorCore; episodeId: number }) {
	const token = window.localStorage.getItem("rn-short-drama-auth-token") || "";
	const headers: Record<string, string> = {};
	if (token) headers.Authorization = `Bearer ${token}`;
	const response = await fetch(`/api/v1/episodes/${episodeId}/opencut-project`, { headers });
	const payload = await response.json().catch(() => null);
	if (!response.ok) {
		throw new Error(payload?.detail?.message || "无法读取剪辑工程");
	}
	const data = payload?.data as RemoteProjectResponse;
	if (!data?.project || !Array.isArray(data.media)) {
		throw new Error("剪辑工程数据不完整");
	}
	const project = deserializeProject({ project: data.project });
	await editor.media.loadProjectMedia({ projectId: project.metadata.id });
	const existingMediaIds = new Set(editor.media.getAssets().map((asset) => asset.id));
	for (const media of data.media) {
		if (existingMediaIds.has(media.media_id)) continue;
		const mediaResponse = await fetch(media.url, { headers });
		if (!mediaResponse.ok) throw new Error(`无法下载素材：${media.name}`);
		const file = new File([await mediaResponse.blob()], media.name, { type: media.mime_type });
		const saved = await editor.media.addMediaAsset({
			projectId: project.metadata.id,
			asset: {
				id: media.media_id,
				name: media.name,
				type: media.type,
				file,
				duration: media.duration,
				width: media.width,
				height: media.height,
			},
		});
		if (!saved) throw new Error(`无法保存素材：${media.name}`);
	}

	let revision = data.revision;
	const saveRemoteProject = async (currentProject: import("@/project/types").TProject) => {
		const saveResponse = await fetch(`/api/v1/episodes/${episodeId}/opencut-project`, {
			method: "PUT",
			headers: { ...headers, "Content-Type": "application/json" },
			body: JSON.stringify({
				expected_revision: revision,
				project: currentProject,
				media_bindings: data.media_bindings,
			}),
		});
		const savePayload = await saveResponse.json().catch(() => null);
		if (!saveResponse.ok) {
			throw new Error(savePayload?.detail?.message || "剪辑工程保存失败");
		}
		revision = Number(savePayload?.data?.revision ?? revision);
	};

	await editor.project.hydrateExternalProject({ project });
	editor.project.setExternalSaveHandler({ handler: saveRemoteProject });
	if (!data.is_initialized) await saveRemoteProject(project);
}

function deserializeProject({ project }: { project: Record<string, unknown> }): import("@/project/types").TProject {
	const metadata = project.metadata as Record<string, unknown>;
	const scenes = (project.scenes as Array<Record<string, unknown>>).map((scene) => ({
		...scene,
		createdAt: new Date(String(scene.createdAt)),
		updatedAt: new Date(String(scene.updatedAt)),
	}));
	return {
		...project,
		metadata: {
			...metadata,
			createdAt: new Date(String(metadata.createdAt)),
			updatedAt: new Date(String(metadata.updatedAt)),
		},
		scenes,
	} as import("@/project/types").TProject;
}

function EditorRuntimeBindings() {
	const editor = useEditor();
	const rippleEditingEnabled = useTimelineStore(
		(state) => state.rippleEditingEnabled,
	);

	useEffect(() => {
		editor.command.isRippleEnabled = rippleEditingEnabled;
	}, [editor, rippleEditingEnabled]);

	useEffect(() => {
		const handleBeforeUnload = (event: BeforeUnloadEvent) => {
			if (!editor.save.getIsDirty()) return;
			event.preventDefault();
			(event as unknown as { returnValue: string }).returnValue = "";
		};

		window.addEventListener("beforeunload", handleBeforeUnload);
		return () => window.removeEventListener("beforeunload", handleBeforeUnload);
	}, [editor]);

	useEditorActions();
	useKeybindingsListener();
	return null;
}
