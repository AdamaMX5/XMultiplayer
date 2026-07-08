# C2 — Messprotokoll (Host-Schiff als dynamisches Objekt)

**Status: gemischt, wie A1-C1.** Die Agent-Seite (`agent/src/index.ts`,
`sessionState.ts`) ist mit echten End-to-End-Tests **VERIFIED**
(der reale Agent-Prozess wird gestartet und über die echte Pipe/WebSocket
beobachtet, `agent/tests/relayToPipe.e2e.test.ts`). Alles Mod-seitige
(`mod/md/XMP_Coop.xml`-Erweiterung um `XMP_Coop_HandleSessionJoin`s
Selbst-Erkennung und `XMP_Coop_AnnounceOwnShip`) ist wie bei A1-C1
ausschließlich auf syntaktische XML-Gültigkeit geprüft, die Semantik ist
komplett ungeprüft — keine X4-Installation verfügbar. **Besonderheit von C2:**
die eigentliche Proxy-Erzeugung/Dead-Reckoning/HP-Logik (`XMP_Arena_HandleSpawn`/
`HandleDespawn`/`HandleStateUpdate`, `aiscripts/XMP.ProxyPilot.xml`) wurde
NICHT verändert — C2 ist strukturell fast ausschließlich eine
Trigger-Ergänzung, kein neuer Proxy-Mechanismus. `npm test --workspaces`:
**305 Tests grün** (78 protocol + 103 agent + 124 server).

**Interne Review-Runde vor diesem Commit** (Agent-Team, drei parallele
Perspektiven auf denselben Diff, wie schon bei C1): Test-Experte,
Sicherheits-Experte und Code-Review-Experte fanden einen echten, wirkungsvollen
Bug im ersten Entwurf, der noch vor dem Commit behoben wurde — siehe
Abschnitt 2.1 für die volle Geschichte. Kurzfassung: der erste Entwurf
kombinierte "ist das unser eigener Beitritt" und "existiert unser Schiff schon"
in EINER Bedingung; existierte das Schiff im Moment des Loopbacks noch nicht
(ein plausibler, von `XMP_Telemetry_BuildAndSend` bereits antizipierter
Zustand), lief fälschlich der Sektor-Export statt der Selbst-Ankündigung, und
da die JS-seitige Zustellung bewusst nur einmal pro WebSocket-Verbindung
versucht wird, hätte es für den Rest der Session KEINE zweite Chance gegeben
— das eigene Schiff wäre nie angekündigt worden. Der Test-Experte fand
zusätzlich, dass der neue E2E-Test tatsächlich nur EINE von zwei behaupteten
Verbindungsreihenfolgen abdeckte; ein zweiter, dedizierter Test wurde ergänzt
(der dabei selbst einen Race-Condition-Bug im TESTCODE aufdeckte und behoben
bekam — siehe Abschnitt 3). Der Sicherheits-Experte fand eine theoretische,
praktisch geringe Namenskollisions-Lücke (Abschnitt 4) und eine fehlende
Sanitizing-Anwendung auf den neuen Loopback-Pfad (behoben). Der
Code-Review-Experte forderte eine DRY-Zusammenfassung der beiden
Loopback-Aufrufstellen (behoben, `deliverCoopSelfJoin()`).

## 1. Das eigentliche Problem: wer löst die Schiffs-Ankündigung aus?

PlanMod.md beschreibt C2 knapp: "Host-Spielerschiff wird beim Gast als Proxy
mit Dead Reckoning gespiegelt. Gast-Schiff wird beim Host gespiegelt (exakt
Arena-Mechanik, Rückkanal)." Die Arena-Mechanik selbst (`spawn`/`despawn`/
`state_update` → `XMP_Arena_HandleSpawn` → `create_ship` + `start_ai_script`
auf `aiscripts/XMP.ProxyPilot.xml`) ist bereits vollständig generisch — sie
prüft nirgends, WARUM ein `spawn` ankam, nur DASS einer ankam. Auch
`XMP_Telemetry_Tick` (A1) sendet `state_update` unconditional, ohne jede
Arena-/Coop-Prüfung. **Das bedeutet: C2 brauchte null Änderungen an der
eigentlichen Proxy-/Dead-Reckoning-/Kampf-Logik.**

Was fehlte, war ausschließlich der ANFANGS-TRIGGER: wie erfährt MD, dass es
gerade Teil einer aktiven Coop-Session ist, damit es das eigene Schiff EINMAL
ankündigt (danach übernehmen die generischen state_update-Ticks). Bei Arena
übernimmt das `XMP_Arena_OnEnterSector` (ausgelöst durch Sektor-Präsenz). Für
Coop gibt es keinen äquivalenten "Sektor-Eintritt" — Sessions werden über den
Agenten's expliziten `"session"`-CLI-Flag/`XMP_SESSION` (A5-Mechanismus)
beigetreten, und dieser Beitritt geht bisher NIE über die Pipe, sondern
ausschließlich direkt vom Agenten zum Relay-Server über WebSocket.

**Zusätzliches, subtileres Problem:** C1s `XMP_Coop_HandleSessionJoin` reagiert
NUR auf einen von einem ANDEREN Mitglied EMPFANGENEN Beitritt (`broadcast()`
schließt den Sender aus). Das erste Mitglied einer Session hat also niemanden,
der ihm einen Beitritt schickt — und würde unter einem naiven "reagiere nur
auf empfangene Joins"-Schema NIE sein eigenes Schiff ankündigen. Dasselbe gilt
symmetrisch fürs zweite Mitglied bezogen auf sein EIGENES (nicht das erste)
Schiff, wenn man versucht wäre, "beim Empfang eines fremden Joins auch das
eigene Schiff mitschicken" zu implementieren — das würde nur die REAGIERENDE
Seite lösen, nicht die join-SENDENDE.

## 2. Die Lösung: Loopback des eigenen Beitritts in die lokale Pipe (`agent/src/index.ts`, `sessionState.ts`)

Statt eines neuen MD-seitigen Präsenz-Mechanismus (der einen neuen
"Coop-Modus"-Schalter gebraucht hätte, den nichts in diesem Projekt bisher
kennt) wird das bestehende, bereits verifizierte A5-Muster wiederverwendet:
wenn der Agent mit explizitem `"session"`-Flag verbindet, sendet er seinen
`session`-`join` wie bisher an den Relay-Server — UND schreibt dieselbe Zeile
jetzt ZUSÄTZLICH in die lokale Pipe. MD sieht dadurch seinen EIGENEN Beitritt
als ganz normale eingehende `session`-Nachricht (`playerName == player.name`
lässt sich davon von einem ECHTEN fremden Beitritt unterscheiden).

**Zwei Verbindungsreihenfolgen, beide abgedeckt:**
- Pipe bereits verbunden, wenn die WebSocket-Verbindung den Beitritt sendet →
  direkter Schreibversuch in `onOpen`s explizitem Zweig.
- Pipe verbindet SPÄTER (der dokumentierte Standardfall laut Root-README:
  "Start the XMultiplayer agent... before or after launching X4") → der erste
  Versuch schlägt lautlos fehl (`pipe.write()` liefert `false`, kein Client
  verbunden), und `onClientConnected` holt `SessionState.lastJoinLine()`
  (neu) nach, sobald das Spiel sich verbindet.

Beide Aufrufstellen laufen seit der Review-Runde durch eine gemeinsame
Funktion, `deliverCoopSelfJoin(raw: string)` (`agent/src/index.ts`) —
ursprünglich zweimal fast identischer Code (Code-Review-Fund), jetzt eine
Stelle, die zusätzlich das Sanitizing übernimmt (Abschnitt 4).

**Bewusst NUR EINMAL pro WebSocket-Verbindung ZUGESTELLT**
(`coopSelfAnnounceDeliveredToPipe`, Modul-Flag in `index.ts`), nicht bei jedem
späteren Pipe-Reconnect erneut versucht — ein Spielneustart mitten in einer
Coop-Session löst den Loopback NICHT nochmal aus. Wichtig: dieses Flag
verfolgt NUR, ob die Zeile erfolgreich in die Pipe geschrieben wurde, NICHT
ob MD sie erfolgreich verarbeitet hat — dieser Unterschied ist genau das, was
im ersten Entwurf zu dem in Abschnitt 2.1 beschriebenen Bug führte.

### 2.1 Von der Review-Runde gefundener und behobener Bug: verlorene Selbst-Ankündigung

**Der erste Entwurf** ließ `mod/md/XMP_Coop.xml`s `XMP_Coop_HandleSessionJoin`
die Selbst-Erkennung UND die Ankündigung selbst in EINER Bedingung
zusammenfassen: `player.entity.exists and $XMP.CoopRxPlayerName ==
player.name` — nur wenn BEIDES gleichzeitig wahr war, wurde
`XMP_Coop_AnnounceOwnShip` aufgerufen; sonst (auch bei einem GENUINEN eigenen
Beitritt, dessen Schiff nur zufällig noch nicht existierte — ein Savegame lädt
noch, der Spieler ist zwischen Schiffen, etc. — exakt dieselbe Übergangslage,
die `XMP_Telemetry_BuildAndSend` bereits mit "no player ship, skipping tick"
behandelt) fiel der Code in den `else`-Zweig und rief **fälschlich
`XMP_Coop_ExportSector` auf, obwohl es der eigene Beitritt war, nicht der
eines fremden Mitglieds.** Da die JS-seitige Zustellung (`deliverCoopSelfJoin`)
bewusst nur einmal pro WebSocket-Verbindung versucht, hätte es **für den Rest
der gesamten Session keine zweite Chance mehr gegeben** — das eigene Schiff
wäre nie angekündigt worden, der emotionale Kern-Moment von C2 ("ich fliege im
Universum meines Freundes neben ihm her") wäre für DIESEN Spieler einfach
ausgeblieben, ohne jede Fehlermeldung.

**Der Fix** (gefunden vom Test-Experten, per Codeanalyse, nicht per
Laufzeittest — keine X4-Installation verfügbar): die Selbst-Erkennung selbst
prüft jetzt NUR NOCH `$XMP.CoopRxPlayerName == player.name`, unabhängig von
`player.entity.exists`, und setzt bei Erfolg lediglich
`$XMP.CoopPendingSelfAnnounce = true`. Eine neue, unabhängige,
sekündlich pollende Cue (`XMP_Coop_SelfAnnounceCheck`, gleiche
Kadenz-Begründung wie `XMP_Arena_PresenceLoop`/`SetaCheck`) prüft danach
kontinuierlich `$XMP.CoopPendingSelfAnnounce and not $XMP.CoopSelfAnnounced
and player.entity.exists` und kündigt an, SOBALD das Schiff existiert —
unabhängig davon, ob das VOR oder NACH dem Empfang des Loopback-Joins der
Fall war. Das entkoppelt "unser Beitritt ist angekommen" (JS-seitig
garantiert mindestens einmal zugestellt) von "unser Schiff ist bereit,
beschrieben zu werden" (MD-seitig beliebig oft neu geprüft, bis es zutrifft).

## 3. `agent/src/sessionState.ts`: `lastJoinLine()` (neu)

Eine kleine, dedizierte neue Methode, getrennt von `resendLines()` (das für
den WS-Reconnect-Fall gedacht ist, server-seitig) — `lastJoinLine()` ist für
den PIPE-(Re-)Connect-Fall (lokales Spiel), ein unabhängiger Anwendungsfall
für dieselben intern gespeicherten Daten (`this.joinLine`). Getestet in
`agent/tests/sessionState.test.ts` (4 neue Tests: unset vor jedem Join,
liefert den letzten Join, `undefined` nach `leave`, unbeeinflusst von
spawn/despawn).

**`agent/tests/relayToPipe.e2e.test.ts`, zwei E2E-Tests statt einem:** der
Test-Experte stellte fest, dass der ursprüngliche einzelne C2-Test (der die
bestehende `withAgentProcess`-Hilfsfunktion wiederverwendet) strukturell NUR
die "Pipe verbindet nach dem WS-Join"-Reihenfolge prüfen kann, weil
`withAgentProcess` immer erst die WS-Verbindung abwartet, bevor die
Testfunktion überhaupt läuft — empirisch über 8 instrumentierte Läufe
bestätigt (der `onOpen`-Direktschreibversuch schlug in allen 8/8 Läufen fehl).
Ein zweiter, eigenständiger Test wurde ergänzt, der den Agent-Prozess selbst
startet und den Pipe-Client so früh wie möglich verbindet, BEVOR die
WebSocket-Verbindung überhaupt abgewartet wird — das macht es sehr
wahrscheinlich (wenn auch nicht hundertprozentig deterministisch erzwungen),
dass der `onOpen`-Pfad statt des `onClientConnected`-Fallbacks greift; die
beobachtbare Assertion (genau eine Join-Zeile kommt an) gilt aber so oder so
korrekt für beide Pfade, macht den Test also unabhängig vom exakten Gewinner
des Wettlaufs robust, nicht flaky.

**Dieser zweite Test deckte dabei selbst einen Bug im TESTCODE auf** (nicht
im Produktivcode): die erste Fassung wartete `await
connectToPipeWithRetry(path)` VOR `await waitForConnection(wss)` ab — da
`wss.once("connection", ...)` ein Einmal-Listener ist, hätte ein Verbindungs-
Event, das WÄHREND der Pipe-Wartezeit bereits feuerte, den erst SPÄTER
angehängten Listener nie erreicht, der Test wäre mit "agent never connected
to fake relay" getimeoutet, obwohl der Agent tatsächlich längst verbunden
war. Behoben durch `waitForConnection(wss)` VOR dem Pipe-Verbindungsversuch
zu starten (als Promise, nicht awaited), und erst danach beide Ergebnisse
abzuwarten — derselbe Grundfehler, den `feedback_ws_burst_tests`-artige
Race-Conditions in diesem Projekt schon einmal verursacht haben (siehe C1s
Erfahrung mit dem hängenden Server-Testlauf), hier aber im Setup EINES
einzelnen Tests statt in dessen Zusicherungen.

## 4. `mod/md/XMP_Coop.xml`: `XMP_Coop_HandleSessionJoin` (erweitert) + `XMP_Coop_AnnounceOwnShip`/`XMP_Coop_SelfAnnounceCheck` (neu)

`XMP_Coop_HandleSessionJoin` (C1) unterschied bisher gar nicht zwischen
Sendern; C2 fügt eine Selbst/Fremd-Unterscheidung ein (`playerName ==
player.name`, seit dem in Abschnitt 2.1 beschriebenen Fix OHNE zusätzliche
`player.entity.exists`-Bedingung):
- **Eigener Beitritt** (der neue Loopback aus Abschnitt 2): setzt
  `$XMP.CoopPendingSelfAnnounce`. Die tatsächliche Ankündigung
  (`XMP_Coop_AnnounceOwnShip`) läuft asynchron über
  `XMP_Coop_SelfAnnounceCheck` (sekündliches Polling, siehe Abschnitt 2.1),
  genau einmal pro Pipe-Verbindung (`$XMP.CoopSelfAnnounced`-Guard,
  zurückgesetzt bei `md.Named_Pipes.Reloaded` über die kleine
  `XMP_Coop_Init`-Cue — dasselbe Reset-Muster wie
  `XMP_Arena_TuningDefaults`/`PresenceLoop` seit A5).
- **Fremder Beitritt** (C1, unverändert): exportiert weiterhin den eigenen
  Sektor. Das eigene Schiff muss dabei NICHT erneut gesendet werden — der
  Server repliziert jeden bereits bekannten `spawn` (unabhängig von dessen
  Herkunft) automatisch an neu beigetretene Mitglieder
  (`server/src/sessionManager.ts`, seit A2 dieselbe Mechanik, die Arena-Proxies
  schon immer nutzen).

`XMP_Coop_AnnounceOwnShip` baut das exakt gleiche `spawn`-JSON wie
`XMP_Arena_OnEnterSector` (dieselben Feldnamen/Annahmen: `player.entity.id`/
`macro.name`/`hullmax`/`shieldmax` — kein neues Risiko, reine Wiederverwendung
einer bereits dokumentierten Annahme). Der resultierende `spawn` durchläuft
danach exakt dieselbe, UNVERÄNDERTE `XMP_Arena_HandleSpawn`-Kette auf der
Empfängerseite — Proxy-Erzeugung, Dead Reckoning, HP-Autorität, alles bereits
seit A2-A4 VERIFIED/PLAUSIBLE dokumentiert, hier nur wiederverwendet.

## 5. Sicherheits-Review: Namenskollision + fehlendes Sanitizing (beide adressiert)

**Namenskollision (MITTEL, praktisch geringes Restrisiko, bewusst nicht
weiter verschärft):** die Selbst-Erkennung basiert auf einem reinen
String-Vergleich von `playerName` (frei wählbar, keine Whitelist/Uniqueness)
gegen `player.name`. Ein böswilliger Client könnte absichtlich denselben Namen
wie das Opfer wählen. Der Sicherheits-Experte bewertete die praktische
Auswirkung aber als gering: `XMP_Coop_AnnounceOwnShip` liest AUSSCHLIESSLICH
lokale `player.entity.*`-Daten, übernimmt nichts aus der eingehenden
Nachricht — ein gefälschter Beitritt kann also bestenfalls eine ECHTE,
korrekte Selbst-Ankündigung VORZEITIG auslösen, aber niemals falsche Daten
einschleusen. Mit dem in Abschnitt 2.1 beschriebenen Pending/Polling-Fix ist
der einzige verbleibende denkbare Schaden (eine dauerhaft unterdrückte
Ankündigung) ohnehin ausgeschlossen, da das Polling unabhängig vom
AUSLÖSENDEN Ereignis so lange weiterprüft, bis das Schiff existiert. Bewusst
NICHT mit einem unspoofbaren Signal (z. B. einem separaten, nur vom Loopback
gesetzten Marker-Feld) verschärft — der Aufwand stünde in keinem Verhältnis
zum verbleibenden, praktisch folgenlosen Risiko; vorgemerkt, falls eine
spätere Härtungsrunde das anders bewertet.

**Fehlendes Sanitizing auf dem Loopback-Pfad (NIEDRIG, behoben):** der
Loopback schrieb ursprünglich direkt in die Pipe, ohne durch
`sanitizeForPipe`/`sanitizeForPipeExtraction` zu laufen (das bisher nur für
vom RELAY kommende Nachrichten in `handleRemoteMessage` galt). Die Quelle ist
zwar der lokale Operator (`config.playerName`, z. B. per `--player-name`/
`XMP_PLAYER_NAME`), aber ein Name mit `{`, `}`, `,` oder Steuerzeichen hätte
lokal `XMP_Arena_ExtractField` gebrochen, während er bei allen ANDEREN
Session-Mitgliedern korrekt (weil server-seitig bereits sanitisiert) ankäme.
Behoben: `deliverCoopSelfJoin()` sanitisiert jetzt konsistent mit
`sanitizeForPipe`, bevor es in die Pipe schreibt.

## 6. Bewusst nicht umgesetzt (dokumentierte Vereinfachungen)

- **Kein explizites "Coop verlassen"** ohne den Agenten zu trennen. Ein
  echter WebSocket-Disconnect räumt bereits alles korrekt auf (generische
  A2-A5-Logik, nie Arena- oder Coop-spezifisch), aber es gibt (anders als
  Arenas sektor-austritt-getriggertes `XMP_Arena_OnExitSector`) keinen Weg,
  eine Coop-Session gezielt zu verlassen, ohne den Prozess zu beenden.
  Relevant erst, sobald C5 ("Sektorwechsel") ansteht.
- **Kampf zwischen gespiegelten Spielerschiffen ist weder verhindert noch
  bewusst ermöglicht** — er "passiert einfach", weil nichts im Protokoll oder
  Server zwischen "Arena-Kampf" und "Coop-Session" unterscheidet (dieselbe
  fehlende Unterscheidung wie C1s Host/Gast-Nichtunterscheidung). Ob PvP
  zwischen Coop-Partnern gewünscht ist, ist eine Produktentscheidung, die
  PlanMod.md nicht explizit trifft — hier dokumentiert statt stillschweigend
  angenommen.

## 7. Nächste Schritte

1. X4 + SirNukes Mod Support APIs installieren; `XMP_Coop_HandleSessionJoin`s
   Selbst/Fremd-Unterscheidung (`playerName == player.name`) UND
   `XMP_Coop_SelfAnnounceCheck`s Polling als Erstes prüfen — ohne
   funktionierenden Vergleich bzw. Polling bleibt entweder die
   Selbst-Ankündigung oder der C1-Sektor-Export dauerhaft aus.
2. Reale Zwei-Spieler-Probe (zwei Agenten, zwei explizite Session-Codes,
   idealerweise auch mit vertauschter Start-Reihenfolge Agent/Spiel) gegen
   einen echten Relay-Server, sobald eine X4-Installation verfügbar ist —
   validiert den in Abschnitt 2 beschriebenen Loopback-Mechanismus tatsächlich
   gegen das echte SirNukes-Pipe-Verhalten (bisher nur gegen den Node-Agenten
   selbst per E2E-Test verifiziert, nicht gegen X4).
3. Produktentscheidung zu Abschnitt 6s Kampf-Frage treffen und ggf. eine
   Coop-spezifische Unverwundbarkeits-/Freundschaftsregel ergänzen, falls PvP
   zwischen Coop-Partnern NICHT gewünscht ist.
4. Falls eine spätere Härtungsrunde Abschnitt 5s Namenskollisions-Restrisiko
   doch schließen will: ein unspoofbares, nur lokal setzbares Signal für die
   Selbst-Erkennung statt des reinen `playerName`-Stringvergleichs einführen.
5. C3 ("NPC-Bubble mit Interest Management") oder C7 ("Remote-Cockpit-Modus",
   laut PlanMod.md "hohe Priorität nach C2 möglich, unabhängig von C3-C6")
   als nächsten Meilenstein bewerten.
