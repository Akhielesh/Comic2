import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Play, Slash } from 'lucide-react';
import { SKILL_CATEGORIES, type ChatSkill } from '../../services/chatSkills';
import { HAIRLINE, MUTED, LABEL, TRANSITION, HEADING, RADIUS_PANEL } from './studioDesign';

// Skills library page — every `/`-command surfaced as a first-class feature card.
// Each card runs its recipe directly (inline argument input + Run), and the same
// commands stay available from the composer by typing `/`.

interface SkillsViewProps {
  skills: ChatSkill[];
  onRunSkill: (skill: ChatSkill, arg: string) => void;
}

/** One feature card: emoji well · copy · /command chip · inline arg input + Run. */
const SkillCard: React.FC<{ skill: ChatSkill; onRun: (arg: string) => void }> = ({ skill, onRun }) => {
  const [arg, setArg] = useState('');
  const [started, setStarted] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const canRun = !skill.argRequired || arg.trim().length > 0;

  const run = () => {
    if (!canRun) return;
    onRun(arg.trim());
    setArg('');
    setStarted(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setStarted(false), 2000);
  };

  return (
    <div
      className={`group flex flex-col gap-3 ${RADIUS_PANEL} ${HAIRLINE} bg-[var(--ds-surface)] p-5 ${TRANSITION} hover:-translate-y-0.5 hover:shadow-[0_2px_4px_rgba(0,0,0,0.04),0_12px_32px_var(--ds-hairline)]`}
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[#D97757]/10 text-[22px] leading-none"
        >
          {skill.emoji}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className={`text-[15px] ${HEADING}`}>{skill.label}</h3>
          <p className={`mt-0.5 text-[12.5px] leading-relaxed ${MUTED}`}>{skill.description}</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <code
          className={`rounded-md ${HAIRLINE} bg-[var(--ds-well)] px-1.5 py-0.5 text-[11px] font-semibold text-[var(--ds-ink)]`}
        >
          /{skill.command}
        </code>
        {(skill.aliases || []).slice(0, 3).map((a) => (
          <code key={a} className={`rounded-md bg-[var(--ds-well)] px-1.5 py-0.5 text-[11px] ${MUTED}`}>
            /{a}
          </code>
        ))}
      </div>

      <div className="mt-auto flex items-center gap-2 pt-1">
        {skill.argRequired ? (
          <input
            value={arg}
            onChange={(e) => setArg(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                run();
              }
            }}
            placeholder={skill.argName}
            className={`min-w-0 flex-1 rounded-xl ${HAIRLINE} bg-[var(--ds-well)] px-3 py-2 text-[13px] text-[var(--ds-ink)] placeholder:text-[var(--ds-muted)] outline-none ${TRANSITION} focus:border-[var(--ds-accent)]`}
          />
        ) : (
          <span className={`flex-1 truncate text-[12px] ${MUTED}`}>{skill.argName}</span>
        )}
        <button
          onClick={run}
          disabled={!canRun}
          className={`flex shrink-0 items-center gap-1.5 rounded-xl px-3.5 py-2 text-[12.5px] font-semibold ${TRANSITION} disabled:opacity-40 ${
            started
              ? 'bg-[#D97757]/10 text-[var(--ds-accent)]'
              : 'bg-[var(--ds-accent)] text-white hover:bg-[var(--ds-accent-hover)]'
          }`}
          title={started ? 'Running in chat' : `Run /${skill.command}`}
        >
          {started ? (
            <>
              <Check className="h-3.5 w-3.5" /> Started ✓
            </>
          ) : (
            <>
              <Play className="h-3.5 w-3.5" /> Run
            </>
          )}
        </button>
      </div>
    </div>
  );
};

export const SkillsView: React.FC<SkillsViewProps> = ({ skills, onRunSkill }) => {
  // Group into the canonical category order; anything uncategorized lands at the end.
  const sections = useMemo(() => {
    const grouped = SKILL_CATEGORIES.map((c) => ({
      ...c,
      skills: skills.filter((s) => s.category === c.id)
    })).filter((c) => c.skills.length > 0);
    const known = new Set(SKILL_CATEGORIES.map((c) => c.id as string));
    const rest = skills.filter((s) => !known.has(s.category));
    if (rest.length > 0) grouped.push({ id: 'create', label: 'More', skills: rest });
    return grouped;
  }, [skills]);

  return (
    <div className="h-full overflow-y-auto bg-[var(--ds-canvas)]">
      <div className="mx-auto w-full max-w-4xl px-4 py-10 sm:px-6">
        {/* Header */}
        <div className="mb-8">
          <div className={`mb-2 inline-flex items-center gap-1.5 rounded-full ${HAIRLINE} bg-[var(--ds-surface-soft)] px-2.5 py-1 ${LABEL}`}>
            <Slash className="h-3 w-3" /> Skill library
          </div>
          <h1 className={`text-2xl sm:text-3xl ${HEADING}`}>Skills</h1>
          <p className={`mt-1.5 max-w-2xl text-[14px] leading-relaxed ${MUTED}`}>
            One-command features. Run them here, type{' '}
            <code className={`rounded-md ${HAIRLINE} bg-[var(--ds-well)] px-1 py-0.5 text-[12px] font-semibold text-[var(--ds-ink)]`}>/</code>{' '}
            in chat, or just ask.
          </p>
        </div>

        {/* Category sections */}
        <div className="space-y-10">
          {sections.map((section) => (
            <section key={section.label}>
              <div className="mb-3 flex items-center gap-3">
                <h2 className={LABEL}>{section.label}</h2>
                <div className="flex-1 border-t border-[var(--ds-hairline-soft)]" />
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {section.skills.map((skill) => (
                  <SkillCard key={skill.command} skill={skill} onRun={(arg) => onRunSkill(skill, arg)} />
                ))}
              </div>
            </section>
          ))}
        </div>

        <p className={`mt-10 text-center text-[12px] ${MUTED}`}>
          Every skill is also a slash command — type <span className="font-semibold">/{skills[0]?.command || 'research'}</span> in
          the composer and the menu takes it from there.
        </p>
      </div>
    </div>
  );
};
