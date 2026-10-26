import { useEffect, useState } from 'react';
import { Button } from './bits';
import { Drawer, DrawerContent } from '../components/arc/drawer/drawer';
import type { ControlKit } from './useControlKit';
import type { ControlPoint } from './useControlPoint';
import { ControlPointSettings } from './ControlPoint';

/** Team number and account. The team number helps spot team-designed parts named after the team. */
export function SettingsDrawer({ kit, cp, open, onOpenChange }: { kit: ControlKit; cp: ControlPoint; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [team, setTeam] = useState(kit.settings.teamNumber ?? '');
  const [saved, setSaved] = useState(false);
  useEffect(() => { if (open) { setTeam(kit.settings.teamNumber ?? ''); setSaved(false); } }, [open, kit.settings.teamNumber]);
  const valid = team === '' || /^\d{1,6}$/.test(team);
  return <Drawer open={open} onOpenChange={onOpenChange}>
    <DrawerContent title="Settings" description="Saved to your account">
      <div className="stack">
        <form className="stack" onSubmit={async event => { event.preventDefault(); if (valid) setSaved(await kit.saveSettings(team)); }}>
          <label className="field">
            <span>Team number</span>
            <input className="text-input num" inputMode="numeric" value={team} onChange={event => { setTeam(event.target.value.trim()); setSaved(false); }} placeholder="For example 4215" aria-invalid={!valid} aria-describedby="team-help" />
            <span id="team-help" className="muted small">{valid ? 'Parts named with your team number are suggested as team-designed.' : 'Use 1 to 6 digits.'}</span>
          </label>
          <div className="inline-actions"><Button type="submit" size="sm" loading={kit.savingSettings} disabled={!valid}>Save</Button>{saved && <span className="muted small" role="status">Saved</span>}</div>
        </form>
        <ControlPointSettings cp={cp} />
        <div className="stack">
          <h3>Account</h3>
          <p className="muted small">Connected to Onshape as {kit.session?.user?.name}. Control Kit only reads your documents.</p>
          <div><Button size="sm" variant="secondary" onClick={() => { onOpenChange(false); void kit.signOut(); }}>Sign out</Button></div>
        </div>
      </div>
    </DrawerContent>
  </Drawer>;
}
