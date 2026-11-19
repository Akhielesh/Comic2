import React, { useEffect, useState } from "react";
import { BookOpen, CheckCircle2, RefreshCw } from "lucide-react";
import { Badge, Button, CARD, CARD_DESCRIPTION, CARD_TITLE } from "./ds";
import { CANVAS_BG, HEADING, RADIUS_CONTROL, RISE_IN, SECTION_ICON_TILE, SHADOW_SOFT, TEXT_3XL, TONE_TEXT } from "./chat/studioDesign";
import { cn } from "../lib/utils";
import { LearnProgress } from "../types";
import { loadLearnProgress, saveLearnProgress } from "../services/db";

type Lesson = {
  id: string;
  title: string;
  summary: string;
};

type Module = {
  id: string;
  title: string;
  description: string;
  lessons: Lesson[];
};

const LEARN_MODULES: Module[] = [
  {
    id: "script",
    title: "Script to Scenes",
    description: "Learn how the script becomes scene breakdowns and what the analyzer expects.",
    lessons: [
      {
        id: "script-basics",
        title: "Scene Headers",
        summary: "Include scene headings and character dialogue to avoid analysis errors."
      },
      {
        id: "script-structure",
        title: "Character Clarity",
        summary: "Introduce characters with short descriptors for better world extraction."
      }
    ]
  },
  {
    id: "style",
    title: "Style & Aspect Ratio",
    description: "Craft style prompts and pick aspect ratios that match your story.",
    lessons: [
      {
        id: "style-tone",
        title: "Tone Matching",
        summary: "Use short, visual adjectives that describe texture, lighting, and mood."
      },
      {
        id: "style-ratio",
        title: "Aspect Ratio Impact",
        summary: "Tall ratios feel dramatic; wide ratios feel cinematic."
      }
    ]
  },
  {
    id: "world",
    title: "World Builder",
    description: "Generate characters, props, and locations that stay consistent.",
    lessons: [
      {
        id: "world-characters",
        title: "Characters & Props",
        summary: "List characters, props, and locations for more coherent images."
      }
    ]
  },
  {
    id: "layout",
    title: "Layout & Dialogue",
    description: "Structure panel breakdowns and dialogue flow.",
    lessons: [
      {
        id: "panel-breakdown",
        title: "Panel Breakdown",
        summary: "Generate panel descriptions and check that dialogue exists."
      }
    ]
  },
  {
    id: "generation",
    title: "Generation & Review",
    description: "Validate image generation and regeneration quality.",
    lessons: [
      {
        id: "cover",
        title: "Cover Composition",
        summary: "Try a hero-centric cover prompt with strong silhouette."
      }
    ]
  }
];

export const LearnHub: React.FC = () => {
  const [progress, setProgress] = useState<Record<string, LearnProgress>>({});

  useEffect(() => {
    loadLearnProgress().then((rows) => {
      const mapped: Record<string, LearnProgress> = {};
      rows.forEach((row) => {
        mapped[row.moduleId] = row;
      });
      setProgress(mapped);
    });
  }, []);

  const markLesson = async (moduleId: string, lessonId: string) => {
    const current = progress[moduleId] || { moduleId, completedLessons: [], updatedAt: Date.now() };
    const updated: LearnProgress = {
      moduleId,
      completedLessons: Array.from(new Set([...current.completedLessons, lessonId])),
      lastLessonId: lessonId,
      updatedAt: Date.now()
    };
    await saveLearnProgress(updated);
    setProgress((prev) => ({ ...prev, [moduleId]: updated }));
  };

  const resetModule = async (moduleId: string) => {
    const updated: LearnProgress = {
      moduleId,
      completedLessons: [],
      lastLessonId: undefined,
      updatedAt: Date.now()
    };
    await saveLearnProgress(updated);
    setProgress((prev) => ({ ...prev, [moduleId]: updated }));
  };

  return (
    <div className={cn('min-h-full text-[var(--ds-ink)]', CANVAS_BG)}>
      <div className={`max-w-6xl mx-auto px-4 py-6 sm:px-6 space-y-6 ${RISE_IN}`}>
        <div className="flex items-center gap-3">
          <span className={SECTION_ICON_TILE} aria-hidden>
            <BookOpen className="w-5 h-5" />
          </span>
          <div className="min-w-0">
            <h1 className={cn(TEXT_3XL, HEADING)}>Learn</h1>
            <p className="text-[length:var(--ds-text-base)] leading-6 text-[var(--ds-muted)]">Guided lessons to master prompts, workflow, and output quality.</p>
          </div>
        </div>

        <div className="grid lg:grid-cols-2 gap-6">
          {LEARN_MODULES.map((module) => {
            const moduleProgress = progress[module.id];
            const completed = moduleProgress?.completedLessons.length || 0;
            const total = module.lessons.length;
            return (
              <div key={module.id} className={cn(CARD, SHADOW_SOFT, 'p-5 gap-4')}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <h3 className={CARD_TITLE}>{module.title}</h3>
                    <p className={cn(CARD_DESCRIPTION, 'mt-0.5')}>{module.description}</p>
                  </div>
                  <Badge variant="secondary" className="tabular-nums">
                    {completed}/{total} complete
                  </Badge>
                </div>

                <div className="space-y-3">
                  {module.lessons.map((lesson) => {
                    const isDone = moduleProgress?.completedLessons.includes(lesson.id);
                    return (
                      <div key={lesson.id} className={cn('border border-[var(--ds-hairline)] bg-[var(--ds-well)] p-3', RADIUS_CONTROL)}>
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0 text-[length:var(--ds-text-base)] font-semibold leading-5 text-[var(--ds-ink)]">{lesson.title}</div>
                          {isDone && <CheckCircle2 className={cn('w-4 h-4 shrink-0', TONE_TEXT.success)} role="img" aria-label="Complete" />}
                        </div>
                        <p className="mt-1 text-[length:var(--ds-text-sm)] leading-5 text-[var(--ds-muted)]">{lesson.summary}</p>
                        <div className="mt-3 flex flex-wrap gap-2">
                          <Button size="sm" variant="outline" onClick={() => markLesson(module.id, lesson.id)}>
                            Mark Complete
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="flex justify-end">
                  <Button size="sm" variant="ghost" onClick={() => resetModule(module.id)}>
                    <RefreshCw aria-hidden /> Reset Progress
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
