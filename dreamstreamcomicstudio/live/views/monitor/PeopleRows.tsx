// A nursery's people: one row per member with their role and name here
// ("Grandma"), editable by parents (and a member's own name by themselves).
// Shared by the nursery hub's People & roles and the Invite sheet.
import React, { useState } from 'react';
import type { NurseryPerson } from '../../monitor/client';
import { ROLE_INFO, type MonRole } from '../../monitor/protocol';
import { Avatar, Btn, Field, Segmented } from '../../ui/primitives';

export const ROLE_ORDER: MonRole[] = ['parent', 'caregiver', 'viewer'];

export function RolePicker({ value, onChange }: { value: MonRole; onChange: (r: MonRole) => void }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <Segmented label="Role" full options={ROLE_ORDER.map((r) => ({ value: r, label: ROLE_INFO[r].label }))} value={value} onChange={(v) => onChange(v as MonRole)} />
      <div className="faint" style={{ fontSize: 12, marginTop: 6 }}>{ROLE_INFO[value].can}</div>
    </div>
  );
}

export function PersonRow({ p, nurseryName, canEdit, canRelabelSelf, canRemove, onSave, onRemove, watching }: {
  p: NurseryPerson;
  nurseryName: string;
  canEdit: boolean;
  canRelabelSelf: boolean;
  canRemove: boolean;
  onSave: (r: MonRole, l: string) => Promise<boolean>;
  onRemove: () => void;
  /** Shown with a dot: watching right now. */
  watching?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [role, setRole] = useState(p.role);
  const [label, setLabel] = useState(p.label ?? '');
  const editable = canEdit || canRelabelSelf;
  return (
    <div className="person-row">
      <div className="row" style={{ gap: 12 }}>
        <Avatar name={p.display_name} size={34} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="pr-name">
            {p.display_name}
            {p.label && <span className="pr-label">{p.label}</span>}
            {p.is_me && <span className="faint" style={{ fontSize: 12 }}> (you)</span>}
          </div>
          <div className="faint" style={{ fontSize: 12 }}>
            {ROLE_INFO[p.role].label}{p.is_owner ? ' · owner' : ''}
            {watching && <span className="inv-watching"> · watching now</span>}
          </div>
        </div>
        {editable && <Btn variant="subtle" size="sm" icon="edit" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label={`${open ? 'Close' : 'Edit'} ${p.display_name}`}>{open ? 'Close' : 'Edit'}</Btn>}
      </div>
      {open && (
        <div className="pr-edit">
          {canEdit && <RolePicker value={role} onChange={setRole} />}
          <Field label="Name in this nursery">
            <input className="input" value={label} maxLength={30} list="label-suggestions" onChange={(e) => setLabel(e.target.value)} placeholder="Grandma, Dad…" />
          </Field>
          {confirm ? (
            <div className="inline-confirm" role="group" aria-label={p.is_me ? 'Confirm leaving' : `Confirm removing ${p.display_name}`}>
              <span>{p.is_me ? `Leave “${nurseryName}”? You’ll lose access.` : `Remove ${p.display_name}? They lose access right away.`}</span>
              <div className="row" style={{ gap: 8 }}>
                <Btn variant="danger" size="sm" onClick={onRemove}>{p.is_me ? 'Leave' : 'Remove'}</Btn>
                <Btn variant="ghost" size="sm" onClick={() => setConfirm(false)}>Cancel</Btn>
              </div>
            </div>
          ) : (
            <div className="row" style={{ marginTop: 10 }}>
              {canRemove && <Btn variant="danger" size="sm" icon="trash" onClick={() => setConfirm(true)}>{p.is_me ? 'Leave' : 'Remove'}</Btn>}
              <span className="spacer" />
              <Btn variant="solid" size="sm" icon="check" onClick={async () => { if (await onSave(canEdit ? role : p.role, label)) setOpen(false); }}>Save</Btn>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
