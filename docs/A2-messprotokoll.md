# A2 — Messprotokoll (Statisches Proxy-Schiff + Arena-Universum)

**Status: ausstehend — benötigt X4-Installation.** Der Node-seitige Teil (Server:
Spawn/Despawn-Tracking, Replay an spät beitretende Mitglieder, Despawn-Broadcast bei
Disconnect; Agent: bidirektionale Pipe) ist lokal getestet (`npm test`). Die
Mod-Seite (Arena-Galaxy-Content, Proxy-Spawn/Teleport in `mod/md/XMP_Arena.xml`) ist
ausschließlich auf syntaktische XML-Gültigkeit geprüft; die Semantik ist komplett
ungeprüft.

## 1. Der mit Abstand größte offene Risikopunkt: JSON-Parsing in MD

**Kanonische Quelle für den Fallback-Plan.** `protocol/protocol.md` ("JSON parsing
in MD") und der Kopfkommentar von `mod/md/XMP_Arena.xml` verweisen beide hierher
statt den Plan jeweils eigenständig zu beschreiben — bei Änderungen an diesem
Abschnitt bitte die beiden anderen Stellen auf Konsistenz prüfen.

`XMP_Arena_ExtractField` (in `mod/md/XMP_Arena.xml`) geht davon aus, dass MD über
eine `find_string`-Aktion sowie `.{substring:...}`/`.{tonumber}`/`.{replace:...}`
wertseitige Operationen verfügt. **Das ist nicht bestätigt** — anders als die in A1
verwendeten Aktionen (`set_value`, `do_if`, String-Konkatenation via `+`), die in
vanilla MD-Scripts breit belegt sind, konnte für diese spezifische String-Such-
/Teilstring-Funktionalität keine Bestätigung gefunden werden.

- [ ] Bestätigen: Existiert `find_string` (oder ein Äquivalent) in dieser Form?
- [ ] Bestätigen: Existieren `.{substring:...}`, `.{tonumber}`, `.{replace:...}`
      als Wert-Postfix-Operationen auf Strings?
- **Update (A3-Review):** Zwei konkrete Logikfehler in `XMP_Arena_ExtractField`s
  Endpositions-Berechnung gefunden und behoben (unbedingtes `min()` mit
  Nicht-gefunden-Sentinel `-1` beim letzten Feld eines Objekts; verschachtelte
  Objektwerte wie `position` wurden am ersten INNEREN Komma statt am eigenen
  Ende abgeschnitten). Details, Fix-Beschreibung und neue offene Fragen dazu in
  `docs/A3-messprotokoll.md` Abschnitt 2.2 — die grundsätzliche Unsicherheit
  über `find_string`/`.{substring:...}` selbst bleibt hier unverändert bestehen.
- [ ] Falls NEIN: Entscheidung zwischen zwei Optionen fällt nach diesem ersten
      In-Game-Test von `XMP_Arena_ExtractField`, nicht vorher:
      - **Option A — ein Feld pro Pipe-Write:** Der Agent (`agent/src/index.ts`,
        `handleRemoteMessage`) zerlegt eingehende Nachrichten vor dem Schreiben in
        die Pipe in mehrere einzelne, primitive Writes (ein Wert pro Write), sodass
        MD nie einen zusammengesetzten String parsen muss.
      - **Option B — `|`-getrenntes Zeilenformat:** Der Agent kodiert eingehende
        Nachrichten als eine einzige `|`-getrennte Zeile statt JSON; MD muss dann
        nur noch auf einem festen Trennzeichen splitten statt verschachteltes JSON
        zu parsen.
      - Beide Optionen sind nur ein Plan auf Papier, keine implementierte
        Alternative — der Agent hat über `parseMessage` bereits vollständiges
        JSON-Parsing, die Umkodierung wäre in beiden Fällen dort trivial
        nachzurüsten.

Da JEDE Form von strukturierten eingehenden Daten (spawn/despawn/state_update von
Remote-Spielern) MD zwingt, mindestens EIN String-Verarbeitungsprimitiv zu nutzen,
ist dieser Punkt nicht umgehbar — nur isoliert (eine einzige Helper-Cue) und damit
im Fehlerfall lokal austauschbar gehalten.

## 2. Weitere Annahmen in `mod/md/XMP_Arena.xml`

1. `md.Named_Pipes.OnLineReceived` ist das korrekte Signal für eingehende
   Pipe-Zeilen, mit der Zeile roh in `event.param3` (symmetrisch zur rohen
   String-Write-Seite aus A1 — angenommen, dass die API in beide Richtungen ein
   dummer Byte-/Zeilen-Pipe ohne JSON-Bewusstsein ist).
2. Proxy-Schiffe werden in einer dynamisch indizierten Tabelle
   `$XMP.Proxies.{objectId}` gehalten (MDs `$Var.{$Key}`-Assoziativ-Index-Muster).
   Ungeprüft, ob dieses Muster in dieser Form funktioniert.
3. `create_ship`s `macro`-Attribut akzeptiert den über die Leitung gesendeten
   `shipType`-String (gesetzt via `player.entity.macro.name` auf der Sende-Seite)
   direkt als Makro-Referenz.
4. `set_object_position` akzeptiert Position UND Rotation in einem Aufruf (laut
   PlanMod.md A2 die vorgesehene naive Teleport-Aktion). Falls die Engine eine
   separate Rotations-Aktion braucht, ist das nach Punkt 1 die zweitwichtigste
   Korrektur.
5. Der neu gespawnte Proxy wird zunächst an `player.entity.position` platziert
   (Platzhalter bis zum ersten `state_update` für dieselbe `objectId` — ungeprüft,
   ob eine sichtbare "Spawn am falschen Ort"-Ruckelphase dadurch entsteht).

## 3. Annahmen in den Galaxy/Gamestart-Dateien (`mod/libraries/*.xml`)

Deutlich unsicherer als die MD-Cue-Syntax aus A1/A2, da hier praktisch keine
domänenspezifische Vorgabe vorlag (im Gegensatz zu A1, wo Cue/Signal-Konventionen
vom Entwickler mitgegeben wurden):

1. `clusters.xml`/`sectors.xml`/`zones.xml`: Grobstruktur (`cluster` → `connections`
   → `sector`-Makro → `zone`-Makro) folgt dem verbreiteten "neuer Sektor"-Modding-
   Muster, aber exakte Attributnamen/Pflichtfelder ungeprüft.
2. `galaxy.xml`: Diff-Patch (`<add sel="/galaxy/connections">`) nimmt an, dass
   `/galaxy/connections` der korrekte XPath-Selector ist und dass ein Cluster ohne
   jede Gate-Verbindung zulässig ist (gewünscht: nur über Gamestart erreichbar).
3. `gamestarts.xml`: Schema (Attribute wie `locationclass`, `location`,
   `showstartmenu`, Kindelemente `mode`/`faction`/`player`/`loadout`) ist die am
   wenigsten sichere Annahme in diesem Milestone neben Punkt 1 oben. Startschiff-
   Makro `ship_arg_s_fighter_01_a_macro` als Platzhalter — Existenz/Name ungeprüft.
4. `t/0001-L044.xml`: Pfad-/Seiten-Konvention (`t/0001-L044.xml`, Page-ID `20206`)
   folgt dem Standardmuster, ungeprüft für diese Extension.
5. "Keine Fraktionen/Jobs/Wirtschaft" wird durch Auslassung erreicht (kein Eintrag
   in god.xml/jobs.xml referenziert den neuen Sektor) — ungeprüft, ob X4 dennoch
   default-mäßig irgendeine Aktivität in unreferenzierte Sektoren einspeist.

## 4. Node-seitig bereits verifiziert (zur Abgrenzung vom Obigen)

- Server: `spawn` wird pro Session getrackt, an spät beitretende Mitglieder
  repliziert, bei Disconnect als `despawn` an verbleibende Mitglieder gebroadcastet,
  Respawn (erneutes `spawn` für dieselbe `objectId`) ersetzt den alten Eintrag statt
  zu duplizieren (`server/tests/session.test.ts`).
- Agent: Pipe ist bidirektional (`PipeServer.write()`); Nachrichten vom Relay-Server
  werden validiert (`parseMessage`) UND gefiltert (`decideRelay`, siehe Punkt 6
  unten) bevor sie in die Pipe geschrieben werden (`agent/tests/pipeServer.test.ts`,
  `agent/tests/relayFilter.test.ts`, `agent/tests/relayToPipe.e2e.test.ts`).
- Simulator (`agent/src/simulate.ts`) ist jetzt zweiseitig: sendet beim Start eine
  `spawn`-Nachricht (Schiffstyp/Owner/ObjectId per CLI) und loggt eingehende
  `spawn`/`despawn`/`state_update`-Nachrichten lesbar. End-to-End mit Relay-Server +
  zwei Simulator-Instanzen gegen zwei Agenten (unterschiedliche `--pipe-name`) lokal
  verifiziert — siehe Abschlussbericht für den Log-Auszug.

## 5. Sicherheits-Auflage: shipType-Whitelist (A2)

`protocol/src/shipMacros.ts` (`SHIP_MACRO_WHITELIST`/`isKnownShipMacro`) ist eine
zweite, vom JSON-Parsing unabhängige Prüfung: Server→Agent→MD ist ab A2 eine
Trust-Boundary (Daten von einem anderen Spieler). Der Agent verwirft `spawn`-
Nachrichten mit unbekanntem `shipType` VOR dem Pipe-Write (`agent/src/relayFilter.ts`,
getestet in `agent/tests/relayFilter.test.ts` und schwarzkistig in
`agent/tests/relayToPipe.e2e.test.ts`). Der Simulator validiert seinen eigenen
`--ship`-Wert beim Start gegen dieselbe Liste (harter Fehler statt stillem
Fehlversand). Die Liste selbst (Makro-Namen) ist PLAUSIBLE, nicht verifiziert —
siehe Kommentar in `shipMacros.ts`.

## 6. Beim lokalen E2E-Test gefundener und gefixter Bug: verlorene Spawns bei später verbundenem Spiel

Während des manuellen Zwei-Simulator-Tests fiel auf: Wenn der Agent bereits der
Session beigetreten ist und ein `spawn` von einem anderen Mitglied relayed bekommt,
BEVOR das lokale Spiel (bzw. im Test: der lokale Simulator) seine Pipe-Verbindung
aufgebaut hat, ging dieser `spawn` unwiederbringlich verloren (`PipeServer.write()`
lieferte `false`, nichts hat das nachgeholt). Anders als bei `state_update` (der
nächste Tick heilt das in 100ms) ist das für `spawn` fatal — ohne ihn kennt die
MD-Seite die `objectId` nie und ignoriert alle folgenden `state_update`s für dieses
Schiff dauerhaft.

Fix: `agent/src/index.ts` hält jetzt `knownSpawns` (eine `Map<objectId, rawLine>`),
aktualisiert bei jedem validen `spawn`/`despawn` unabhängig vom Schreiberfolg, und
spielt sie komplett erneut ein, sobald die Pipe (wieder) verbindet
(`onClientConnected` → `replayKnownSpawns()`). Deckt sowohl "Spiel verbindet später
als der erste Spawn" als auch "Spiel/Mod startet mitten in der Session neu" ab.
Regressionstest: `agent/tests/relayToPipe.e2e.test.ts` ("a spawn that arrives before
the game connects is replayed once the pipe client connects").

## 7. Nächste Schritte

1. X4 + SirNukes Mod Support APIs installieren, Extension aktivieren, Arena-
   Gamestart anwählen — prüfen, ob überhaupt ein Spiel startet (Punkt 3 oben ist
   hier das größte Abbruchrisiko).
2. Zwei Clients verbinden, Abschnitt 1 (JSON-Parsing) als Erstes validieren —
   ohne funktionierendes Parsing ist der Rest des Krieges nicht zu testen.
3. Bei Erfolg: sichtbares Teleport-Ruckeln bewerten (PlanMod.md A2 "Go/No-Go für
   A3"), Ergebnis hier dokumentieren.
