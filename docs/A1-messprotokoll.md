# A1 — Messprotokoll (Telemetrie-Export)

**Status: ausstehend — benötigt X4-Installation.** Alles unten ist Vorlage; keine der
Messungen wurde bisher in-game durchgeführt. Der End-to-End-Pfad Simulator → Pipe →
Agent → Relay-Server wurde lokal ohne X4 verifiziert (siehe agent `npm run simulate`);
offen ist ausschließlich die reale MD-Seite.

## 1. Gemessene MD-Update-Rate (kritische Kennzahl, PlanMod.md 4.1)

| Szenario | Ziel-Rate | Gemessene mdRate (MD-seitig) | Gemessene Agent-Hz | Sequenzlücken/min | Notizen |
|---|---|---|---|---|---|
| Leerer Sektor, keine anderen Objekte | 10 Hz | — | — | — | |
| Asteroidenfeld (Referenzdichte) | 10 Hz | — | — | — | |
| Unter Last (Kampf-Szenario, A4-Vorgriff) | 10 Hz | — | — | — | |
| SETA aktiv | n/a | — | — | — | Erwartung: Zeitbasis verschiebt sich, siehe PlanMod.md 0.4 |

Messmethode: Agent-Konsole gibt alle 5s `agentHz` und `mdRate` aus (siehe
`agent/src/index.ts`); `mdRate` kommt direkt aus dem MD-Feld `mdRate` in jeder
`state_update`-Nachricht (siehe `XMP_Telemetry_MeasureRate` in
`mod/md/XMP_Telemetry.xml`).

## 2. Pipe-Framing-Validierung

**Angenommen (zu prüfen):** SirNukes Mod Support APIs sendet keine eigene
Längenpräfix-Framing auf MD-Ebene; der Agent behandelt den Pipe-Stream als
Newline-delimited JSON (NDJSON), siehe `agent/src/ndjson.ts`.

- [ ] Bestätigen: Eine `md.Named_Pipes.Write`-Aktion pro MD-Tick erzeugt genau eine
      NDJSON-Zeile beim Agent (kein zusätzliches Framing, keine Teilzeilen durch die
      API selbst).
- [ ] Bestätigen: Sonderzeichen im JSON-String (insbesondere `\n` durch
      Spielernamen o.ä.) werden von der API nicht verändert/escaped.
- [ ] Bestätigen: Verbindungsverhalten beim Game-Exit (sauberer Socket-Close vs.
      Absturz ohne Close) - Agent behandelt beides identisch (siehe
      `onClientDisconnected` in `agent/src/pipeServer.ts`), aber unvalidiert.

## 3. Offene Annahmen (aus `mod/md/XMP_Telemetry.xml`)

1. `md.Named_Pipes.Reloaded` ist das korrekte Signal, dass die API bereit ist.
2. `md.Named_Pipes.Write` wird per `signal_cue_instantly` mit Parameter-Tabelle
   `{pipe=..., msg=...}` ausgelöst; es ist kein separater "Connect"-Schritt nötig.
3. Es gibt ein Fehler-Signal (angenommen `md.Named_Pipes.OnWriteError`) für
   fehlgeschlagene Writes - Name und Auslösebedingung ungeprüft.
4. Der Pipe-Name `xmultiplayer` wird von der API auf `\\.\pipe\x4_xmultiplayer`
   gemappt (Namenskonvention der SirNukes-API, ungeprüft).
5. `player.entity.quaternion` liefert die Schiffsrotation als Quaternion direkt
   nutzbar; falls die Engine nur Euler-Winkel oder eine andere Objektform liefert,
   muss die Konvertierung im MD-Script ergänzt werden.
6. Es gibt ein Erfolgs-Signal (angenommen `md.Named_Pipes.OnWriteSuccess`), das
   den Backoff zurücksetzt (`XMP_Telemetry_WriteSucceeded`). Ohne dieses Signal
   gibt es aktuell keine Möglichkeit, einen wieder gesunden Pipe-Zustand zu
   erkennen - Name und Existenz ungeprüft, ggf. muss stattdessen ein einfacher
   Timeout-basierter Ansatz (z.B. "kein Fehler seit N Sekunden = gesund") her.

## 4. Nächste Schritte

1. X4 + SirNukes Mod Support APIs installieren, `mod/` als Extension aktivieren.
2. Agent starten (`npm start` in `/agent`), Verbindung im Log bestätigen.
3. Tabelle in Abschnitt 1 für mind. 3 Szenarien ausfüllen (je 60s Messfenster).
4. Abschnitt 2 und 3 als Checkliste abarbeiten, Ergebnisse hier dokumentieren.
5. Bei Rate < 3-5 Hz: Pivot-Kriterium aus PlanMod.md 1.3 prüfen.
