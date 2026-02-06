import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Project, ComicPanel, DialogueBlock, TextLayout, ProjectComment } from '../types';
import { AiAssistant } from './AiAssistant';
import { X, MessageCircle, ChevronLeft, ChevronRight, Maximize2, Minimize2, BookOpen, MessageSquareText, ThumbsUp, ThumbsDown } from 'lucide-react';
import { ensureDialogueBlocks } from '../services/dialogueUtils';
import { loadReaderState, saveReaderState } from '../services/db';

interface ComicReaderProps {
  project: Project;
  onClose: () => void;
  onUpdateProject: (projectId: string, updates: Partial<Project> | ((prev: Project) => Partial<Project>)) => void;
}

export const ComicReader: React.FC<ComicReaderProps> = ({ project, onClose, onUpdateProject }) => {
  const [showChat, setShowChat] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.innerWidth >= 768;
  });
  const [showStory, setShowStory] = useState(false);
  const [showComments, setShowComments] = useState(false);
  const [readerMode, setReaderMode] = useState<'scroll' | 'flip'>('scroll');
  const [pageIndex, setPageIndex] = useState(0);
  const [flipDirection, setFlipDirection] = useState<'next' | 'prev' | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [commentAuthor, setCommentAuthor] = useState('');
  const [commentText, setCommentText] = useState('');
  const readerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const saveTimer = useRef<number | null>(null);
  const textLayout = project.state.textLayout || 'caption';

  useEffect(() => {
    loadReaderState(project.id).then((state) => {
      if (!state) return;
      setReaderMode(state.mode);
      if (typeof state.pageIndex === 'number') setPageIndex(state.pageIndex);
      if (typeof state.scrollTop === 'number') {
        requestAnimationFrame(() => {
          if (scrollRef.current) scrollRef.current.scrollTop = state.scrollTop || 0;
        });
      }
    });
  }, [project.id]);

  useEffect(() => {
    const handleChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handleChange);
    return () => document.removeEventListener('fullscreenchange', handleChange);
  }, []);

  useEffect(() => {
    return () => {
      persistReaderState();
    };
  }, []);

  useEffect(() => {
    persistReaderState({ mode: readerMode, pageIndex });
  }, [readerMode]);

  const persistReaderState = (override?: Partial<{ mode: 'scroll' | 'flip'; pageIndex: number; scrollTop: number }>) => {
    const payload = {
      projectId: project.id,
      mode: override?.mode ?? readerMode,
      pageIndex: override?.pageIndex ?? pageIndex,
      scrollTop: override?.scrollTop ?? (scrollRef.current?.scrollTop || 0),
      updatedAt: Date.now()
    };
    saveReaderState(payload);
  };

  const getDialogueBlocks = (panel: ComicPanel): DialogueBlock[] => {
    return ensureDialogueBlocks(panel.dialogue, panel.dialogueBlocks, panel.description);
  };

  const renderPanelText = (panel: ComicPanel, layout: TextLayout) => {
    const blocks = getDialogueBlocks(panel);
    if (layout === 'none' || blocks.length === 0) return null;

    if (layout === 'chat_bubbles') {
      return (
        <div className="mt-2 space-y-2 px-4 pb-4">
          {blocks.map(block => (
            <div
              key={block.id}
              className={`max-w-[80%] px-3 py-2 rounded-lg border-2 border-black text-xs font-comic font-bold ${
                block.side === 'right'
                  ? 'ml-auto bg-brand-blue text-white'
                  : 'bg-brand-yellow text-black'
              }`}
            >
              {block.speaker ? <span className="mr-1">{block.speaker}:</span> : null}
              {block.text}
            </div>
          ))}
        </div>
      );
    }

    if (layout === 'speech_bubbles') {
      return (
        <div className="absolute inset-0 pointer-events-none">
          {blocks.map((block, idx) => (
            <div
              key={block.id}
              className={`absolute text-[11px] font-comic font-bold bg-white/90 border-2 border-black px-2 py-1 rounded ${
                block.side === 'right'
                  ? 'top-2 right-2'
                  : block.side === 'center'
                  ? 'top-2 left-1/2 -translate-x-1/2'
                  : 'top-2 left-2'
              }`}
              style={{ top: `${8 + idx * 32}px` }}
            >
              {block.speaker ? <span className="mr-1">{block.speaker}:</span> : null}
              {block.text}
            </div>
          ))}
        </div>
      );
    }

    return (
      <div className="bg-white/90 border-2 border-black p-2 absolute bottom-4 left-4 right-4 text-center font-comic font-bold text-sm md:text-base rounded shadow-sm">
        {blocks.map(block => block.text).filter(Boolean).join(' ')}
      </div>
    );
  };

  const getLayoutClass = () => {
    switch(project.state.layoutType) {
      case 'webtoon': return 'flex flex-col items-center gap-4';
      case 'strip': return 'flex flex-col gap-2';
      case 'graphic_novel': return 'grid grid-cols-3 gap-4 auto-rows-fr';
      case 'conversation_grid': return 'grid grid-cols-2 gap-4 auto-rows-fr';
      case 'splash_insets': return 'grid grid-cols-3 gap-4 auto-rows-[200px]';
      case 'golden_ratio': return 'grid grid-cols-3 gap-4 auto-rows-[180px]';
      case 'diagonal_action': return 'grid grid-cols-2 gap-4 auto-rows-[200px]';
      case 'storyboard': return 'grid grid-cols-3 gap-2 auto-rows-[150px]';
      case 'manga': return 'grid grid-cols-2 gap-4 auto-rows-fr';
      case 'cinematic': return 'grid grid-cols-1 gap-4';
      case 'grid':
      case 'custom':
      default:
        return 'grid grid-cols-1 md:grid-cols-2 gap-6';
    }
  };

  const getPanelClass = (idx: number) => {
    switch (project.state.layoutType) {
      case 'splash_insets':
        return idx === 0 ? 'col-span-3 row-span-2' : 'col-span-1 row-span-1';
      case 'golden_ratio':
        return idx === 0 ? 'col-span-2 row-span-2' : 'col-span-1 row-span-1';
      case 'diagonal_action':
        return idx % 3 === 0 ? 'col-span-2 row-span-1' : 'col-span-1 row-span-1';
      case 'graphic_novel':
        return idx % 4 === 0 ? 'col-span-2 row-span-1' : 'col-span-1 row-span-1';
      default:
        return 'col-span-1 row-span-1';
    }
  };

  const pages = useMemo(() => {
    const list: Array<{ type: 'cover' | 'panel'; panel?: ComicPanel; imageUrl?: string }> = [];
    if (project.state.coverImageUrl) {
      list.push({ type: 'cover', imageUrl: project.state.coverImageUrl });
    }
    project.state.panels.forEach((panel) => {
      list.push({ type: 'panel', panel, imageUrl: panel.imageUrl });
    });
    return list;
  }, [project.state.coverImageUrl, project.state.panels]);

  useEffect(() => {
    if (pageIndex >= pages.length && pages.length > 0) {
      setPageIndex(pages.length - 1);
    }
  }, [pages.length]);

  const handleScroll = () => {
    if (readerMode !== 'scroll') return;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      persistReaderState({ scrollTop: scrollRef.current?.scrollTop || 0 });
    }, 400);
  };

  const goNext = () => {
    if (pageIndex >= pages.length - 1) return;
    setFlipDirection('next');
    setPageIndex((prev) => {
      const next = prev + 1;
      persistReaderState({ pageIndex: next, mode: 'flip' });
      return next;
    });
  };

  const goPrev = () => {
    if (pageIndex <= 0) return;
    setFlipDirection('prev');
    setPageIndex((prev) => {
      const next = prev - 1;
      persistReaderState({ pageIndex: next, mode: 'flip' });
      return next;
    });
  };

  useEffect(() => {
    if (!flipDirection) return;
    const timer = window.setTimeout(() => setFlipDirection(null), 320);
    return () => window.clearTimeout(timer);
  }, [flipDirection]);

  const toggleFullscreen = async () => {
    if (!document.fullscreenElement && readerRef.current) {
      await readerRef.current.requestFullscreen().catch(() => null);
      setIsFullscreen(true);
    } else {
      await document.exitFullscreen().catch(() => null);
      setIsFullscreen(false);
    }
  };

  const handleAddComment = () => {
    const trimmed = commentText.trim();
    if (!trimmed) return;
    const newComment: ProjectComment = {
      id: crypto.randomUUID(),
      author: commentAuthor.trim() || undefined,
      text: trimmed,
      createdAt: Date.now(),
      likes: 0,
      dislikes: 0
    };
    onUpdateProject(project.id, (prev) => ({
      state: { ...prev.state, comments: [...(prev.state.comments || []), newComment] }
    }));
    setCommentText('');
    setCommentAuthor('');
  };

  const handleVote = (commentId: string, deltaLikes: number, deltaDislikes: number) => {
    onUpdateProject(project.id, (prev) => ({
      state: {
        ...prev.state,
        comments: (prev.state.comments || []).map((comment) => {
          if (comment.id !== commentId) return comment;
          return {
            ...comment,
            likes: Math.max(0, (comment.likes || 0) + deltaLikes),
            dislikes: Math.max(0, (comment.dislikes || 0) + deltaDislikes)
          };
        })
      }
    }));
  };

  return (
    <div ref={readerRef} className="fixed inset-0 z-50 bg-slate-100 overflow-hidden flex flex-col">
      {/* Reader Header */}
      <header className="h-16 bg-white border-b-4 border-black flex items-center justify-between px-6 shadow-lg shrink-0">
        <h1 className="font-display text-2xl text-black truncate">{project.name}</h1>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowStory((prev) => !prev)}
            className="text-xs font-bold border-2 border-black rounded-lg px-3 py-1 bg-slate-50 flex items-center gap-1"
          >
            <BookOpen className="w-4 h-4" /> Story
          </button>
          <button
            onClick={() => setShowComments((prev) => !prev)}
            className="text-xs font-bold border-2 border-black rounded-lg px-3 py-1 bg-slate-50 flex items-center gap-1"
          >
            <MessageSquareText className="w-4 h-4" /> Comments
          </button>
          <button
            onClick={() => setReaderMode(readerMode === 'scroll' ? 'flip' : 'scroll')}
            className="text-xs font-bold border-2 border-black rounded-lg px-3 py-1 bg-brand-yellow"
          >
            {readerMode === 'scroll' ? 'Page Flip' : 'Scroll'}
          </button>
          <button
            onClick={toggleFullscreen}
            className="text-xs font-bold border-2 border-black rounded-lg px-3 py-1 bg-slate-50 flex items-center gap-1"
          >
            {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
            {isFullscreen ? 'Exit' : 'Full'}
          </button>
          <button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-full transition-colors">
              <X className="w-6 h-6" />
          </button>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden">
        {/* Main Comic Area */}
        <div className="flex-1 overflow-hidden bg-slate-200">
          {readerMode === 'scroll' ? (
            <div
              ref={scrollRef}
              onScroll={handleScroll}
              className="h-full overflow-y-auto custom-scrollbar p-4 md:p-8 flex justify-center"
            >
              <div className="max-w-4xl w-full bg-white shadow-2xl min-h-full">
                {showStory && (
                  <div className="p-6 border-b-4 border-black bg-white">
                    <div className="border-2 border-black rounded-lg p-4 bg-slate-50">
                      <div className="text-xs font-bold uppercase text-slate-500 mb-2">Story</div>
                      <pre className="whitespace-pre-wrap font-comic text-sm text-slate-700">{project.state.script || "No story text yet."}</pre>
                    </div>
                  </div>
                )}
                {project.state.coverImageUrl && (
                  <div className="p-6 border-b-4 border-black bg-slate-100">
                    <div className="border-4 border-black rounded-lg overflow-hidden shadow-comic">
                      <img src={project.state.coverImageUrl} alt={`${project.name} cover`} className="w-full h-auto" />
                    </div>
                  </div>
                )}
                <div className={`p-8 grid gap-6 ${getLayoutClass()}`}>
                  {project.state.panels.map((panel, idx) => (
                    <div key={idx} className={`border-2 border-black shadow-sm relative ${getPanelClass(idx)}`}>
                      <img src={panel.imageUrl} alt={panel.description} className="w-full h-auto" />
                      {renderPanelText(panel, textLayout)}
                    </div>
                  ))}
                  {project.state.panels.length === 0 && (
                    <div className="col-span-full text-center py-20 text-slate-400 font-display text-2xl">
                      This comic hasn't been drawn yet!
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="h-full flex flex-col items-center justify-center p-6">
              <div className="max-w-4xl w-full bg-white shadow-2xl border-4 border-black rounded-xl overflow-hidden">
                {showStory && (
                  <div className="p-4 border-b-4 border-black bg-white">
                    <div className="border-2 border-black rounded-lg p-3 bg-slate-50">
                      <div className="text-xs font-bold uppercase text-slate-500 mb-2">Story</div>
                      <pre className="whitespace-pre-wrap font-comic text-sm text-slate-700">{project.state.script || "No story text yet."}</pre>
                    </div>
                  </div>
                )}
                {pages.length > 0 ? (
                  <div className={`relative bg-white ${flipDirection === 'next' ? 'animate-page-flip-next' : flipDirection === 'prev' ? 'animate-page-flip-prev' : ''}`}>
                    {pages[pageIndex]?.imageUrl && (
                      <img src={pages[pageIndex].imageUrl} alt="Comic page" className="w-full h-auto" />
                    )}
                    {pages[pageIndex]?.panel && renderPanelText(pages[pageIndex].panel!, textLayout)}
                  </div>
                ) : (
                  <div className="p-10 text-center text-slate-400 font-display text-2xl">This comic hasn't been drawn yet!</div>
                )}
                <div className="flex items-center justify-between p-4 border-t-4 border-black bg-slate-50">
                  <button onClick={goPrev} className="px-3 py-2 border-2 border-black rounded-lg text-xs font-bold flex items-center gap-1 bg-white">
                    <ChevronLeft className="w-4 h-4" /> Prev
                  </button>
                  <div className="text-xs font-bold">{pageIndex + 1} / {Math.max(pages.length, 1)}</div>
                  <button onClick={goNext} className="px-3 py-2 border-2 border-black rounded-lg text-xs font-bold flex items-center gap-1 bg-white">
                    Next <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Sidebar (Chat) */}
        <div className={`
            fixed md:relative inset-y-0 right-0 w-full md:w-auto bg-white border-l-4 border-black transform transition-transform duration-300 z-40 overflow-visible
            ${showChat ? 'translate-x-0' : 'translate-x-full md:translate-x-0 md:w-0 md:border-none'}
        `}>
            <div className="h-full w-full md:w-auto border-l-4 border-black md:border-none overflow-visible">
                 <AiAssistant script={project.state.script} />
            </div>
             {/* Mobile Close Chat */}
            <button onClick={() => setShowChat(false)} className="absolute top-4 right-4 md:hidden p-2 bg-black text-white rounded-full">
                <X size={20}/>
            </button>
        </div>
      </div>

      {showComments && (
        <div className="fixed inset-y-0 left-0 w-full md:w-96 bg-white border-r-4 border-black z-50 shadow-comic flex flex-col">
          <div className="p-4 border-b-4 border-black flex items-center justify-between">
            <div className="font-display text-xl">Comments</div>
            <button onClick={() => setShowComments(false)} className="p-2 rounded-full hover:bg-slate-100">
              <X className="w-5 h-5" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {(project.state.comments || []).length === 0 && (
              <div className="text-sm font-comic text-slate-500">No comments yet. Be the first!</div>
            )}
            {(project.state.comments || []).map((comment) => (
              <div key={comment.id} className="border-2 border-black rounded-lg p-3 bg-slate-50">
                <div className="flex items-center justify-between text-xs font-bold text-slate-500">
                  <div>{comment.author || "Anonymous"}</div>
                  <div>{new Date(comment.createdAt).toLocaleDateString()}</div>
                </div>
                <div className="mt-2 text-sm font-comic text-black">{comment.text}</div>
                <div className="mt-3 flex items-center gap-3 text-xs font-bold">
                  <button onClick={() => handleVote(comment.id, 1, 0)} className="flex items-center gap-1">
                    <ThumbsUp className="w-4 h-4" /> {comment.likes || 0}
                  </button>
                  <button onClick={() => handleVote(comment.id, 0, 1)} className="flex items-center gap-1">
                    <ThumbsDown className="w-4 h-4" /> {comment.dislikes || 0}
                  </button>
                </div>
              </div>
            ))}
          </div>
          <div className="p-4 border-t-4 border-black space-y-2">
            <input
              value={commentAuthor}
              onChange={(e) => setCommentAuthor(e.target.value)}
              placeholder="Your name (optional)"
              className="w-full border-2 border-black rounded px-3 py-2 text-xs"
            />
            <textarea
              value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
              placeholder="Write a comment..."
              className="w-full border-2 border-black rounded px-3 py-2 text-sm min-h-[80px]"
            />
            <div className="flex justify-end">
              <button onClick={handleAddComment} className="px-3 py-2 border-2 border-black rounded-lg text-xs font-bold bg-brand-yellow">
                Post Comment
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Floating Chat Toggle for Mobile/Tablet */}
      <button 
        onClick={() => setShowChat(!showChat)}
        className="md:hidden fixed bottom-6 right-6 w-14 h-14 bg-brand-yellow border-4 border-black rounded-full flex items-center justify-center shadow-comic z-50"
      >
        <MessageCircle className="w-8 h-8 text-black" />
      </button>
    </div>
  );
};
