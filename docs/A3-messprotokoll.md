# A3 — Messprotokoll (Dead Reckoning per AI-Script)

**Status: ausstehend — benötigt X4-Installation.** A3 ist überwiegend ein
Mod-Milestone; der Node-seitige Teil (kanonische Re-Serialisierung im Agent,
geschätzte + geglättete Link-Latenz) ist lokal getestet (`npm test`). Alles
Mod-seitige ist ausschließlich auf syntaktische XML-Gültigkeit geprüft
(PowerShell `[xml]`-Parser); die Semantik ist komplett ungeprüft, wie schon bei
A1/A2.

## 1. Neue Datei: `mod/aiscripts/XMP.ProxyPilot.xml`

Erstes AI-Script in diesem Projekt (bisher nur MD-Scripts). Höheres Risiko als die
MD-Cue-Syntax aus A1/A2, weil für AI-Scripts keine domänenspezifische Vorgabe
vorlag und die Konventionen strukturell anders sind (kein `<cue>`/`<conditions>`,
sondern `<aiscript>`/`<params>`/`<init>`/`<do_while>`). Name bewusst
punktgetrennt (`XMP.ProxyPilot`, nicht `XMP_Proxy_DeadReckoning`), da echte
X4-AI-Script-Namen üblicherweise diese Namensraum-Konvention nutzen:

- [ ] Bestätigen: Ist die gewählte `<aiscript>`-Grundstruktur (bare
      `<params>`/`<init>`/`<do_while>`, ohne `<properties>`/`<attention>`-Wrapper)
      für ein einfaches, dauerhaft laufendes Bewegungsscript gültig? Die
      `<attention>`-Wrapper-Variante ist eher für reaktive/unterbrechende
      AI-Scripts üblich — bewusst NICHT gewählt, um weniger unbestätigte Syntax
      einzuführen, aber das ist selbst eine Annahme.
- [ ] Bestätigen: Existiert `move.to.position` in dieser Form/Attributnamen?
      Ebenso `move.stop`.
- [ ] Bestätigen: Aktualisiert ein erneuter `move.to.position`-Aufruf den
      laufenden Bewegungsbefehl, oder wird er hinten angereiht (Queue)? Falls
      Queue: Fix ist ein `move.stop`-Aufruf unmittelbar davor.
- [ ] Bestätigen: Bleibt die Standard-Kollisionsvermeidung aktiv, wenn kein
      deaktivierendes Attribut übergeben wird (PlanMod.md A3 verlangt das
      explizit) — oder braucht es stattdessen ein explizit AKTIVIERENDES Attribut?
- [ ] Bestätigen: `object.blackboard` als MD-↔-AI-Script-Datenkanal (siehe
      Abschnitt 3) — ohne ihn bräuchte dieses Script eine komplett andere Anbindung.
- [ ] Bestätigen: Braucht ein Proxy-Schiff einen zugewiesenen NPC-Piloten, bevor
      ein AI-Script es fliegen kann? `XMP_Arena_HandleSpawn` ruft dafür jetzt
      defensiv ein angenommenes `create_pilot` vor `start_ai_script` auf (siehe
      Abschnitt 6) — könnte sich als unnötig herausstellen, z. B. falls
      `create_ship`s Makro für kampffähige Schiffe bereits eine Standard-Crew
      mitbringt.

## 2. Gefundene und behobene Bugs (Review-Runden 2+3)

Reine XML/MD-Logikfehler, ohne Node-Beteiligung, alle vor dem ersten
In-Game-Test gefunden (Code-Review, nicht Laufzeittest — es gibt keinen
MD-Interpreter außerhalb von X4 selbst; wo eine Node-seitige Simulation des
Algorithmus existiert, siehe `protocol/tests/canonical.test.ts`
`simulateMdExtractField`, ist das explizit vermerkt).

### 2.1 `do_if`/`else`-Struktur in `XMP.ProxyPilot.xml` (Klarstellung, kein bewiesener Laufzeitbug)

Die ursprüngliche Struktur hatte im Update-Timeout-Block ein `<else>` als Kind
des ÄUSSEREN `do_if` (Vergleich `$SinceLastUpdate > $UpdateTimeoutSec`), direkt
nach einem INNEREN, abgeschlossenen `do_if value="not $IsStopped"`. Die erste
Review-Runde vermutete, X4s `do_if`/`else`-Auflösung paare `<else>` mit dem
nächstgelegenen VORANGEHENDEN Geschwister-`do_if` (hier also dem inneren) statt
mit strikter XML-Elternschaft — diese Diagnose wurde in der dritten Review-Runde
**zurückgezogen**: die Repo-Konvention (durchgängige Verwendung von
`<do_if><do_all>...</do_all><else>...</else></do_if>` in `XMP_Telemetry.xml`/
`XMP_Arena.xml`) spricht eher dafür, dass reine XML-Elternschaft gilt und die
ursprüngliche Struktur schon korrekt gewesen wäre. Es gibt keine Möglichkeit,
das ohne echten X4-Interpreter zu entscheiden.

**Beibehalten wird trotzdem die umstrukturierte Fassung** (Element unmittelbar
vor jedem `<else>` ist immer ein `<do_all>`, nie ein abgeschlossenes `<do_if>`),
weil sie unabhängig davon, welche Paarungsregel tatsächlich gilt, unzweideutig
ist und exakt dem im restlichen Repo etablierten Muster folgt — nicht weil ein
Laufzeitfehler bewiesen wäre. `$IsStopped` wird weiterhin auch im
"kein Timeout"-Zweig explizit auf `false` gesetzt (zweite Absicherung, falls ein
neues Update eintrifft, während `$IsStopped` noch `true` war) — das bleibt
unabhängig von der Paarungsfrage ein sinnvolles Sicherheitsnetz.

- [ ] Die `do_if`/`else`-Paarungsregel selbst (Geschwister vs. Elternschaft) ist
      und bleibt ungeklärt — im ersten In-Game-Test möglichst mit einem
      gezielten Testfall prüfen, der mehrfach hintereinander zwischen den
      Zweigen wechselt, unabhängig von `$UpdateTimeoutSec` im Speziellen.

### 2.2 `XMP_Arena_ExtractField` (`XMP_Arena.xml`): drei Fehler in Endposition und Nachbearbeitung

1. **Letztes-Feld-Problem:** `$XMP.ExtractEnd` war unbedingt
   `min(nextCommaPos, nextBracePos)`. Ist das extrahierte Feld das LETZTE in
   seinem Objekt (z. B. `owner` in einer spawn-Nachricht), gibt es kein
   folgendes Komma — `find_string`s Nicht-gefunden-Ergebnis (angenommen `-1`)
   ging als "kleinste" Position direkt in `min()` ein und lieferte einen
   Leerstring statt des echten Werts. **Fix:** expliziter `-1`-Check, Fallback
   auf die Klammerposition.
2. **Verschachtelte-Objekte-Problem (beim Beheben von 1 gefunden, nicht Teil
   der ursprünglichen Meldung):** `position`/`rotation`/`velocity` sind selbst
   JSON-Objekte mit eigenen internen Kommas (`{"x":1,"y":2,"z":3}`). Die
   unbedingte Komma-Suche fand das ERSTE INNERE Komma (zwischen x und y) statt
   des Endes des GESAMTEN Objekts — `$XMP.RxPositionJson` etc. wurden auf
   Fragmente wie `{"x":1` abgeschnitten, wodurch die anschließende
   Sub-Extraktion von x/y/z auf kaputtem Input operierte. **Fix:** Erkennung, ob
   ein Wert mit `{` beginnt; für Objekte wird NUR nach der passenden
   schließenden Klammer gesucht (kein Komma-Vergleich) — gültig, weil diese drei
   Objekte in diesem Protokoll nie weiter verschachteln. Die schließende Klammer
   wird in die extrahierte Teilzeichenkette mit aufgenommen, damit die
   Sub-Extraktion ihrerseits eine `}` für ihr eigenes letztes Feld hat (`z`/`qw`).
3. **Bedingungsloser Quote-Strip (dritte Review-Runde, hebt Fix 2 wieder auf):**
   die letzte Zeile der Cue wandte `.{replace: '&quot;', ''}` UNBEDINGT auf das
   Ergebnis an — auch auf den Objekt-Zweig aus Fix 2. Für einen Skalarwert
   (`"Alice"`) korrekt (entfernt die eigenen umschließenden Anführungszeichen);
   für ein Objekt (`{"x":10,"y":20,"z":30}`) entfernte es ZUSÄTZLICH die
   Anführungszeichen um die verschachtelten Key-Namen (`{x:10,y:20,z:30}`). Die
   Sub-Extraktion sucht aber immer nach einem GEQUOTETEN Key (`"x":`) — fand
   also nichts mehr. Effekt: 100% der Positions-/Rotations-/
   Geschwindigkeitsdaten wären ausgefallen, unabhängig vom Letztes-Feld-Fall.
   **Fix:** Quote-Strip nur noch im Skalar-Zweig; der Objekt-Zweig gibt die rohe
   Teilzeichenkette unverändert (inkl. aller Anführungszeichen) zurück.

Alle drei Fixes und ihr Zusammenspiel sind in `protocol/tests/canonical.test.ts`
(`simulateMdExtractField`, eine Node-Portierung des exakten Cue-Algorithmus) mit
einem vollständigen Feld-für-Feld-Durchlauf einer echten `state_update`-Zeile
gegengetestet (11 Tests, alle grün).

- [ ] Bestätigen: `find_string` liefert tatsächlich `-1` (nicht z. B. eine
      Exception oder `null`) wenn das Suchmuster nicht gefunden wird — diese
      Annahme trägt jetzt alle drei Fixes.
- [ ] Bestätigen: `.{substring: a, b}` mit `a == b` liefert einen Leerstring statt
      eines Fehlers (relevant falls ein Objektwert direkt `{}` wäre — kommt in
      diesem Protokoll nicht vor, aber nicht geprüft).
- [ ] Bestätigen (jetzt nur noch für den Skalar-Zweig relevant, seit Fix 3):
      ersetzt `.{replace: '&quot;', ''}` ALLE Vorkommen von `"` im String, oder
      nur das erste? Für Skalarwerte (maximal zwei Anführungszeichen: Anfang und
      Ende der Zeichenkette) macht das keinen Unterschied — relevant würde es
      erst, falls ein Skalarwert selbst ein Anführungszeichen enthält (siehe
      nächster Punkt).
- [ ] **Bekannte, nicht behobene Grenze:** ein String-WERT, der selbst ein
      literales `}` oder `,` enthält (z. B. ein Spielername wie
      `"{CoolClan} Alice"`), bricht die Extraktion vorzeitig ab — die
      Endpositions-Suche kennt keine gequoteten String-Grenzen, sie findet
      einfach das erste `}`/`,` nach Wertbeginn, egal ob es Teil des Strings
      selbst ist. Nicht neu (gilt seit dem ursprünglichen A2-Extraktor), aber
      bisher nie relevant, weil A1–A3 keine frei von Spielern eingegebenen
      Strings durch diese Cue schicken. **Wird relevant ab A5** (Session-Komfort:
      echte Spielernamen, ggf. Chat) — dann braucht es entweder Escaping auf
      Agent-Seite (Verbot/Ersetzung von `{`/`}`/`,` in Anzeigenamen vor dem
      Pipe-Write) oder den in `docs/A2-messprotokoll.md` Abschnitt 1 dokumentierten
      Fallback (Wechsel weg von JSON auf der Pipe). Konkret demonstriert in
      `protocol/tests/canonical.test.ts` ("PLAUSIBLE, pre-existing gap: a string
      value containing a literal '}' truncates extraction early").

## 3. Datenkanal MD → AI-Script: `object.blackboard`

Da MD-Variablen (`$XMP.*` in `XMP_Arena.xml`) für ein AI-Script vermutlich nicht
sichtbar sind, schreibt `XMP_Arena_HandleStateUpdate` die "letzte bekannte
Wahrheit" direkt auf das Blackboard des Proxy-Schiffs selbst
(`$XMP.Proxies.{objectId}.blackboard.$XMP_TargetPosX/Y/Z`,
`...$XMP_TargetVelX/Y/Z`, `...$XMP_TargetRecvTime`), da das Script mit `this` auf
genau diesem Objekt läuft. `XMP_Arena_HandleSpawn` seedet dieselben Felder direkt
beim Erzeugen (Spawn-Position, Geschwindigkeit 0), damit die erste
AI-Script-Iteration nicht auf einen Null-Wert trifft.

- [ ] Bestätigen: Existiert `object.blackboard` mit lese-/schreibbaren,
      beliebig benannten Feldern, wie hier angenommen?
- [ ] Falls NEIN: Alternative wäre eine von MD verwaltete, dem AI-Script beim
      Start als Parameter übergebene Objektreferenz auf eine gemeinsame
      Datenstruktur — nicht umgesetzt, da `blackboard` die naheliegendste,
      in der Modding-Community am häufigsten für genau diesen
      MD-↔-AI-Script-Anwendungsfall genannte Lösung ist.

## 4. Snap- vs. Flug-Entscheidung

Bei jeder Loop-Iteration: wenn sich `$XMP_TargetRecvTime` seit der letzten
gesehenen Iteration geändert hat (= neues Update kam an), wird die quadrierte
Distanz zwischen der AKTUELLEN Position des Proxys und der neu empfangenen
Wahrheit mit `$SnapThresholdMeters²` verglichen (quadriert statt echter Distanz,
um keine ungeprüfte `sqrt`-Funktion zu brauchen — für einen reinen
Größer-als-Vergleich mathematisch gleichwertig). Bei Überschreitung: harter
Teleport (`set_object_position`, derselbe A2-Teleport-Mechanismus, hier als
Fallback wiederverwendet statt neu erfunden), sonst läuft die kontinuierliche
Extrapolation weiter Richtung neuem Ziel.

- [ ] Bestätigen: Ergibt sich aus dem Live-Test ein sinnvoller
      `$SnapThresholdMeters`-Wert? Default 500m ist eine Schätzung für S/M-Klasse.

## 5. Tuning-Parameter (PlanMod.md A3 "Tuning")

Zentral in `XMP_Arena_TuningDefaults` (Cue in `XMP_Arena.xml`) gesammelt und beim
`start_ai_script`-Aufruf explizit als Parameter übergeben (überschreibt die
`<param default="...">`-Werte im AI-Script), statt nur in der AI-Script-Datei
verstreut:

| Parameter | Default | Zweck |
|---|---|---|
| `$ExtrapolationHorizonSec` | 1.5s | Deckelt die extrapolierte Zeitspanne pro Schritt, falls ein Boost-Update sehr hohe Geschwindigkeit trägt. |
| `$SnapThresholdMeters` | 500m | Ab dieser Abweichung: hart teleportieren statt nachfliegen. |
| `$UpdateTimeoutSec` | 5s | Länger als der Extrapolationshorizont: wenn seit `$UpdateTimeoutSec` gar kein Update mehr kam (Verbindung vermutlich weg), wird die Bewegung komplett gestoppt (`move.stop`) statt immer weiter auf Basis uralter Daten zu extrapolieren. |
| `$RetargetIntervalSec` | 0.3s | Wie oft das AI-Script neu bewertet/den Flugbefehl erneuert — bewusst viel langsamer als die 10Hz-Netzwerkrate, die Engine-Flugsteuerung sorgt für die framegenaue Glätte zwischen zwei Neubewertungen. |

- [ ] Alle vier Werte nach erstem Test mit echten Latenzen/Speeds neu bewerten
      und hier mit Messergebnissen aktualisieren (Vorlage: Abschnitt 8).

## 6. Pilot-Zuweisung

`XMP_Arena_HandleSpawn` ruft jetzt vor `start_ai_script` ein angenommenes
`create_pilot name="..." ship="$XMP.NewProxyShip" race="argon"` auf. Grund: nicht
sicher, ob ein AI-Script einen Schiffsrumpf ohne zugewiesenen NPC-Piloten
überhaupt steuern kann. Rein defensiv — siehe Abschnitt 1, letzter Punkt, für den
Fall, dass sich das als unnötig herausstellt.

## 7. Geschätzte und geglättete Link-Latenz (Agent → Pipe)

`agent/src/latency.ts` (`estimateLatencyMs`) schätzt die einseitige
Übertragungsverzögerung als Differenz zwischen lokaler Uhr und dem `ts`-Feld
der Nachricht (bereits Teil jeder Nachricht) — bewusst statt eines
WebSocket-Ping/Pong-Mechanismus gewählt, weil dafür keine neue Timer-/
Reconnect-Logik nötig ist. Seit der zweiten Review-Runde zusätzlich auf
`[0, MAX_LATENCY_MS]` geklemmt (2000ms) — ein Wert darüber ist mit sehr viel
höherer Wahrscheinlichkeit Uhrenversatz als echte Latenz.

`agent/src/latencyTracker.ts` (`LatencyTracker`) glättet die Rohwerte pro
Absender (`shipId`) mit einem EWMA (`alpha=0.2` Standard), damit ein einzelner
Ausreißer (GC-Pause, WLAN-Hänger) den Extrapolationshorizont nicht bei jeder
Nachricht neu durcheinanderwirft. Wird bei jedem `spawn`/`despawn` für diese
`objectId` zurückgesetzt (`reset()`), damit ein Reconnect/Respawn nicht mit
veralteter Historie startet.

`agent/src/pipeMessage.ts` hängt den geglätteten Wert als `linkLatencyMs` an
`state_update`-Zeilen an, BEVOR sie in die Pipe geschrieben werden (kein Teil
des WebSocket-/Session-Protokolls, nur dieser eine Pipe-Hop — siehe
`protocol/protocol.md` "Pipe-only fields"). MD liest das Feld und verrechnet es
direkt in den Empfangszeitpunkt auf dem Blackboard
(`$XMP_TargetRecvTime = player.age - linkLatencyMs/1000`), sodass die ohnehin
vorhandene Elapsed-Berechnung im AI-Script automatisch "Position +
Geschwindigkeitsvektor × Latenz" umsetzt, ohne eigene Latenz-Logik dort. Der
Simulator (`agent/src/simulate.ts`) loggt den Wert mit (`latency=...ms`-Suffix
an der `remote pos`-Zeile), sofern vorhanden.

- [ ] **Zentrale Annahme, unbedingt zuerst prüfen: Uhren-Synchronität.** Die
      Methode geht davon aus, dass die Uhren von Sender- und Empfänger-Rechner
      hinreichend nah beieinander liegen (kein NTP-Abgleich wird irgendwo in
      diesem Projekt erzwungen). Bei spürbarem Uhrenversatz liefert
      `linkLatencyMs` systematisch falsche Werte — jetzt zumindest auf
      `[0, MAX_LATENCY_MS]` begrenzt, aber innerhalb dieser Grenze weiterhin
      potenziell falsch. Falls das in der Praxis relevant wird: Wechsel auf
      echtes WebSocket-Ping/Pong (RTT/2) statt Timestamp-Differenz.
- [ ] Nach erstem Test: ist `alpha=0.2` sinnvoll, oder braucht es pro
      Schiffstyp/Geschwindigkeit einen anderen Glättungsfaktor?
- [ ] Ist `MAX_LATENCY_MS=2000` (2s) eine sinnvolle Grenze für die erwarteten
      Verbindungen, oder zu großzügig/zu knapp?

## 8. Verhalten bei Boost/harten Drehungen (PlanMod.md A3, akzeptierte Grenze)

Extrapolation nimmt konstante Geschwindigkeit zwischen zwei Updates an. Eine harte
Drehung oder ein Boost/Abbremsen direkt nach dem letzten bekannten Update erzeugt
zwangsläufig eine kurze, sichtbare Fehlvorhersage — behoben entweder durch das
nächste reguläre Update oder (bei zu großer Abweichung) durch die Snap-Schwelle
oben. Kein Anspruch auf ein echtes Bewegungsmodell; akzeptiert gemäß
PlanMod.md 0.4/1.3 (Erwartungsmanagement).

## 9. Messvorlage: In-Game-Tuning und Vergleich zur A2-Baseline

Auszufüllen nach erstem funktionierendem Test (Voraussetzung: JSON-Parsing aus
A2, `docs/A2-messprotokoll.md` Abschnitt 1, muss funktionieren, sonst kommt gar
kein `state_update` beim Blackboard an). PlanMod.md A2 fragt explizit "wie
schlimm ist das Ruckeln wirklich" — diese Tabelle ist die direkte Antwort darauf.

| Szenario | A2 (naives Teleport) | A3 (Dead Reckoning) | Notizen |
|---|---|---|---|
| Geradeausflug, konstante Geschwindigkeit | — | — | Erwartung: A3 sichtbar glatter |
| Enge Kurve/Kehre | — | — | Erwartung: kurzer sichtbarer Fehlgriff bei A3 (Abschnitt 8) |
| Boost/Sprint | — | — | Erwartung: A3 überschießt kurz, korrigiert beim nächsten Update |
| Kurzer Verbindungsabbruch (<`$UpdateTimeoutSec`) | — | — | A3: sollte einfach an alter Flugbahn weiter extrapolieren |
| Langer Verbindungsabbruch (>`$UpdateTimeoutSec`) | — | — | A3: sollte stoppen (`move.stop`) und dauerhaft stehen bleiben, nicht nach einem Zwischenschritt wieder losfliegen (Abschnitt 2.1) |
| Reconnect nach langer Pause | — | — | A3: sollte snap-teleportieren (Abschnitt 4), nicht von weit her einfliegen |

Kalibrierte Endwerte für Abschnitt 5 hier eintragen, sobald die Tabelle gefüllt ist.

## 10. Nächste Schritte

1. X4 + SirNukes Mod Support APIs installieren, Extension mit `mod/aiscripts/`
   aktivieren — prüfen, ob das AI-Script überhaupt geladen/gestartet wird
   (`start_ai_script`, Abschnitt 1, ist hier das größte Abbruchrisiko).
2. Voraussetzung ist weiterhin funktionierendes JSON-Parsing aus A2
   (`docs/A2-messprotokoll.md` Abschnitt 1) — ohne eingehende `state_update`s kein
   Datenfluss zum Blackboard, damit auch kein Dead-Reckoning-Test möglich.
3. Abschnitt 9 (Messvorlage) mit echten Beobachtungen füllen, insbesondere den
   "langer Verbindungsabbruch"-Fall (prüft Abschnitt 2.1s Fix direkt).
4. Tuning-Werte aus Abschnitt 5 anhand des Tests kalibrieren.
5. Uhren-Synchronität aus Abschnitt 7 als Erstes prüfen, bevor die
   Latenz-Kompensation als funktionierend angenommen wird.
