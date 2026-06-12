import React, { useEffect, useState } from "react";
import { BookOpen, CheckCircle2, RefreshCw } from "lucide-react";
import { Button } from "./Button";
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
    <div className="max-w-6xl mx-auto p-6 space-y-6 animate-fade-in">
      <div className="flex items-center gap-3">
        <BookOpen className="w-7 h-7" />
        <div>
          <h1 className="text-4xl font-display">Learn</h1>
          <p className="text-sm font-comic text-slate-600">Guided lessons to master prompts, workflow, and output quality.</p>
        </div>
      </div>

      <div className="grid lg:grid-cols-2 gap-6">
        {LEARN_MODULES.map((module) => {
          const moduleProgress = progress[module.id];
          const completed = moduleProgress?.completedLessons.length || 0;
          const total = module.lessons.length;
          return (
            <div key={module.id} className="bg-white border-4 border-black rounded-xl shadow-comic p-4 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-display text-xl">{module.title}</h3>
                  <p className="text-xs font-comic text-slate-600">{module.description}</p>
                </div>
                <div className="text-xs font-bold bg-slate-50 border-2 border-black rounded px-2 py-1">
                  {completed}/{total} complete
                </div>
              </div>

              <div className="space-y-3">
                {module.lessons.map((lesson) => {
                  const isDone = moduleProgress?.completedLessons.includes(lesson.id);
                  return (
                    <div key={lesson.id} className="border-2 border-black rounded-lg p-3 bg-slate-50">
                      <div className="flex items-center justify-between">
                        <div className="font-bold text-sm">{lesson.title}</div>
                        {isDone && <CheckCircle2 className="w-4 h-4 text-green-600" />}
                      </div>
                      <p className="text-xs text-slate-600 mt-1">{lesson.summary}</p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button size="sm" variant="secondary" onClick={() => markLesson(module.id, lesson.id)}>
                          Mark Complete
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="flex justify-end">
                <Button size="sm" variant="outline" onClick={() => resetModule(module.id)} icon={<RefreshCw className="w-4 h-4" />}>
                  Reset Progress
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
