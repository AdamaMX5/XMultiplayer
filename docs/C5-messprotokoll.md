# C5 — Messprotokoll (Sektorwechsel)

**Status: gemischt, wie A1-C4.** Protokoll ist mit echten Tests **VERIFIED**.
Alles Mod-seitige (`mod/md/XMP_Coop.xml`s neue `XMP_Coop_SectorChangeLoop`/
`SectorChangeCheck`/`HandleSectorChange`-Cues, die neue
`$XMP.CoopSectorProxyKnownIds`-Liste, die Erweiterung von
`XMP_Coop_HandleSessionJoin` um die `sector_change`-Aktion) ist wie bei A1-C4
ausschließlich auf syntaktische XML-Gültigkeit geprüft
(`System.Xml.XmlDocument.Load`), die Semantik ist komplett ungeprüft — keine
X4-Installation verfügbar.

**Interne Review-Runde vor diesem Commit** (Agent-Team, drei parallele
Perspektiven auf denselben Diff, wie schon bei C1-C4): ein kleiner Fund vor
dem Commit behoben. Der Test-Experte bestätigte Protokoll = **VERIFIED**
(85/85 Tests grün) und Mod = **PLAUSIBLE** (beide XML-Dateien laden weiterhin
gültig, Dispatch-Pfad und Tabellen-Paarungen beim Nachlesen bestätigt), fand
aber einen veralteten Kommentar in `mod/md/XMP_Arena.xml` (behauptete,
`XMP_Coop_HandleSessionJoin` prüfe nur auf `action == 'join'` — inzwischen
seit dieser Milestone auch `sector_change`) — korrigiert. Der Code-Review-
Experte vergab **✅ Akzeptiert** ohne Änderungswunsch (Polling-Idiom
konsistent mit `XMP_Arena_PresenceLoop`/C3s `BubbleCheck`; die Entscheidung,
`XMP_Coop_HandleSectorChange`s NPC-Bubble-Reset NICHT über `XMP_Coop_
ForgetBubbleNpc` laufen zu lassen, wurde gegen dessen tatsächlichen Code
verifiziert, nicht nur gegen den Kommentar geglaubt). Der Sicherheits-Experte
fand keinen Fund über MITTEL, das eine MITTEL-Einstufung betrifft aber kein
neues C5-Risiko, sondern ein bereits seit C1 bestehendes Verstärkungsmuster,
das C5 lediglich um einen zweiten, gleichwertigen Auslöser ergänzt (siehe
Abschnitt 5).

## 1. Umfang: zwei konkrete PlanMod.md-Punkte, ein dritter erweist sich als bereits gelöst

PlanMod.md nennt für C5 drei Punkte:

1. "Gate-Durchflug des Gasts: Bubble abreißen, neuen Sektor übertragen"
2. "Als expliziter 'Ladebildschirm-Moment' gestalten (Fade/Hinweis), kein
   nahtloser Übergang nötig"
3. "Edge Case: Host und Gast in verschiedenen Sektoren → beide Bubbles
   parallel pflegen oder Gast-Bubble priorisieren (Entscheidung nach
   C3-Performance-Daten)"

Punkt 3 stellte sich bei näherer Prüfung als **bereits durch das bestehende
Design gelöst** heraus, nicht als offene Architekturfrage: die NPC-Bubble
(C3, `XMP_Coop_BubbleCheck`) zentriert pro Client auf dessen EIGENE
Schiffsposition und fragt `player.sector` bei jedem Tick frisch ab — völlig
unabhängig von jedem anderen Client. Zwei Mitglieder in verschiedenen
Sektoren bekommen also schon heute automatisch zwei unabhängige, korrekt
skalierte Bubbles, ohne dass "parallel pflegen" explizit gebaut werden
müsste — das war nie als "eine gemeinsame Bubble" implementiert. Was
tatsächlich fehlte: die STATISCHE Sektor-Mirror (C1) wird beim
Sektorwechsel eines Mitglieds nicht abgebaut (C1 hatte das explizit auf C5
verschoben) und niemand bekommt automatisch einen frischen Export für den
NEUEN Sektor. Punkte 1 und 2 sind also der eigentliche Kern von C5.

Bewusst NICHT verwechselt mit der in `docs/C3-messprotokoll.md` offen
gelassenen Bubble-ZENTRUMS-Generalisierung ("auf jedes ANDERE Mitglied
zentrieren statt nur auf sich selbst", relevant für 3+-Spieler-Sessions) —
das ist eine andere, unabhängige Frage und bleibt weiterhin offen.

## 2. Protokoll — `SessionAction` um `"sector_change"` erweitert

Neuer Enum-Wert `"sector_change"` auf `SessionAction`
(`protocol/src/messages.ts`), validiert in `protocol/src/parse.ts`s
`SESSION_ACTIONS`. Keine neuen Felder — die bestehende `session`-Hülle
(`sessionCode`, `playerName`) reicht aus. Getestet in
`protocol/tests/parse.test.ts` (1 neuer Test).

**Nebenbei behobene, bereits vorher bestehende Doku-Inkonsistenz:**
`protocol/protocol.md` und `protocol/schema/v1.json` waren seit A5 nie für
`seta_on`/`seta_off` aktualisiert worden (beide listeten nur
`"join"|"leave"|"ready"|"countdown"`). Da C5 exakt diese Enum-Zeile
anfassen musste, wurden beide Doku-Dateien in derselben Änderung auf den
tatsächlichen Stand von `messages.ts`/`parse.ts` gebracht (inkl. der neuen
`sector_change`-Aktion) — eine günstige Konsistenz-Nebenkorrektur, kein
eigenständiges Feature.

## 3. Mod — Sektorwechsel-Erkennung und Teardown (`mod/md/XMP_Coop.xml`)

### 3.1 Erkennung: `XMP_Coop_SectorChangeLoop`/`SectorChangeCheck`

Neue, eigenständige 1s-Polling-Schleife (gleiches Taktungs-Idiom wie
`XMP_Arena_PresenceLoop`/`SetaLoop`), läuft bedingungslos ab `Reloaded` —
wie `XMP_Coop_BubbleTuningDefaults`/`BubbleCheck` (C3) verlässt sie sich
darauf, dass der SERVER jede Nachricht außerhalb einer aktiven
Session-Mitgliedschaft ohnehin verwirft
(`sessions.sessionCodeOf(clientId)`-Prüfung, `server/src/server.ts`),
statt sich selbst auf `$XMP.CoopSelfAnnounced` zu gaten. Ein leerer
String als Startwert für `$XMP.CoopLastSectorMacroName` verhindert, dass
die allererste Beobachtung nach einem (Neu-)Laden fälschlich als
"Wechsel" gewertet wird — dieselbe Rolle, die `$XMP.WasInArenaSector =
false` für den booleschen Vergleich in `XMP_Arena_PresenceLoop` spielt,
hier nur für einen String-Baseline ohne natürlichen "false"-Wert adaptiert.

### 3.2 Teardown: `XMP_Coop_HandleSectorChange`

Bei erkannter Änderung, drei Schritte:

1. **Statische Sektor-Mirror abbauen** (C1s explizit verschobene Aufgabe):
   jedes aktuell gehaltene Placeholder-Objekt aus `$XMP.SectorProxies` wird
   zerstört; dafür musste C1s bislang rein schlüssel-basierte Tabelle
   (nur Existenz-Check, keine iterierbare Liste) um eine parallele Liste
   `$XMP.CoopSectorProxyKnownIds` ergänzt werden (`XMP_Coop_HandleSectorObject`
   hängt jetzt bei jeder Neuanlage an — dasselbe "Liste neben Tabelle
   führen"-Idiom wie C3s `$XMP.CoopBubbleKnownIds`).
2. **NPC-Bubble sofort abreißen** (PlanMod.md's Wortlaut "Bubble abreißen"
   wörtlich genommen): statt die vorhandenen `$XMP.CoopBubbleStaleTimeoutSec`
   (5s) abzuwarten, wird jede aktuell verfolgte NPC sofort despawnt (Grund
   `"sector_change"`, unterscheidbar von C3s `"left_bubble"`) und alle drei
   Pro-ID-Tabellen aus C3/C4 plus die Known-Ids-Liste selbst geleert — dasselbe
   Aufräumen wie C4s `XMP_Coop_ForgetBubbleNpc`, nur für ALLE IDs auf einmal
   statt für eine einzelne (deshalb kein Aufruf dieser Cue: sie ist auf
   "eine ID per Rebuild-ohne-diese-ID entfernen" zugeschnitten, ein
   Komplettreset braucht diesen Rebuild nicht).
3. **`session` `sector_change` broadcasten**: löst bei JEDEM anderen
   Mitglied `XMP_Coop_HandleSessionJoin`s neuen `sector_change`-Zweig aus,
   der `XMP_Coop_ExportSector` erneut aufruft (exakt dieselbe Reaktion wie
   auf einen fremden `join`) — der Umzügler bekommt so einen frischen
   Export für den neuen Sektor, ohne dass ein neuer Nachrichtentyp
   nötig war.

**Bewusst kein Selbst/Fremd-Unterscheidung nötig** (anders als
`XMP_Coop_HandleSessionJoin`s `join`-Zweig): `sector_change` hat keinen
Agent-seitigen Pipe-Loopback-Mechanismus wie ein expliziter Session-Join
(C2) — es erreicht `XMP_Coop_HandleSessionJoin` ausschließlich über den
normalen Server-Broadcast, der den Sender strukturell immer ausschließt.

### 3.3 Bekannte, akzeptierte Vereinfachungen

- **`sessionCode` bleibt `"arena"` hardcodiert** in der `sector_change`-
  Nachricht — dieselbe bereits bestehende Ungenauigkeit, die
  `XMP_Arena_SetaCheck`s `seta_on`/`seta_off`-Broadcasts seit A5 schon
  haben (MD kennt den echten Coop-Sessioncode nie, nur der Agent). Harmlos:
  der Server liest `sessionCode` außer bei `action: "join"` nirgends aus.
- **Kein Fade/Ladebildschirm-UI**: PlanMod.md selbst sagt "kein nahtloser
  Übergang nötig" — der Teardown ist ein sofortiger, stiller Zustands-Reset,
  X4s EIGENER Gate-Ladebildschirm liefert den vom Wortlaut gemeinten
  "Moment" bereits, ohne dass dieser Mod etwas Zusätzliches anzeigen müsste.
- **Kein neuer Snap-Correction-Code** für das eigene Schiff auf fremden
  Clients: ein Gate-Durchflug ist ein Positionssprung weit jenseits von
  `$XMP.DeadReckoningSnapThresholdMeters` (500m) — `aiscripts/
  XMP.ProxyPilot.xml`s bereits bestehender Dead-Reckoning-Snap-Teleport (A3)
  greift automatisch, kein neuer Code nötig.

## 5. Von der Sicherheits-Review gefunden, bewusst nicht in C5 behoben

Kein KRITISCH/HOCH/MITTEL-Fund, der C5 selbst zuzurechnen wäre. Eine
MITTEL-Einstufung betrifft ein bereits SEIT C1 bestehendes, jetzt lediglich
doppelt erreichbares Muster: `session` `sector_change` landet (wie jede
andere Nachricht außer `join`/`leave`/`chat`/`hit_report`/`spawn`/
`state_update`/`despawn`/`fire_event`/`hp_state`/`sector_mirror`/
`sector_object`) im generischen Passthrough-Zweig von `server.ts` und
durchläuft denselben `generalLimiter` wie alles andere — kein Rate-Limit-
Bypass. Der eigentliche Punkt: EINE kleine `sector_change`-Nachricht löst
bei JEDEM anderen Mitglied einen vollen `XMP_Coop_ExportSector`-Sektor-Walk
plus `sector_object`-Burst aus — ein Verstärkungseffekt, der aber
strukturell identisch mit dem bereits seit C1 bestehenden Verhalten von
`join` ist (`XMP_Coop_HandleSessionJoin`s "jemand anderes ist beigetreten"-
Zweig ruft dieselbe `XMP_Coop_ExportSector` auf, unverändert seit C1; ein
bereits verbundener Client konnte diese Verstärkung schon vor C5 durch
wiederholtes `join`-Spam auslösen). C5 fügt nur einen zweiten, gleichwertigen
Auslöser für ein bereits bestehendes Muster hinzu, keine neue Angriffsklasse.
**Nicht in diesem Milestone behoben** — Empfehlung der Review für eine
spätere Härtung: ein kurzer serverseitiger Cooldown pro `clientId` speziell
für `join`/`sector_change`-Broadcasts, oder eine mod-seitige Debounce in
`XMP_Coop_HandleSessionJoin` vor einem erneuten `XMP_Coop_ExportSector`-Lauf.

## 6. Nächste Schritte

1. X4-Installation nötig, um alle C5-Annahmen zu prüfen: insbesondere, ob
   ein `destroy_object`-Aufruf auf ein `create_station`-erzeugtes
   Placeholder-Objekt (C1) genauso funktioniert wie auf ein `create_ship`-
   erzeugtes Schiff (bislang der einzige real getestete `destroy_object`-
   Anwendungsfall in diesem Mod).
2. Reale Beobachtung, ob die 1s-Polling-Latenz für die
   Sektorwechsel-Erkennung spürbar ist (ein Spieler könnte kurz nach dem
   Gate-Durchflug noch die alte Mirror sehen, bevor der nächste Tick
   feuert) — Tuning-Kandidat, falls störend.
3. Die in C3 offen gelassene Bubble-Zentrums-Generalisierung (auf jedes
   ANDERE Mitglied statt nur auf sich selbst zentrieren, relevant für
   3+-Spieler-Sessions) bleibt unabhängig von C5 weiterhin offen.
4. C6 ("Kommando-Relay") oder C7 ("Remote-Cockpit-Modus", laut PlanMod.md
   "nach C2 möglich, unabhängig von C3-C6", ggf. mit besserem
   Aufwand/Erlebnis-Verhältnis) aufsetzen.
