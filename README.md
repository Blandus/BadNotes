# Folio

**Make space for ideas.**

Folio ist eine kostenlose, browserbasierte Notiz- und Lernanwendung für PC und iPad. Sie verbindet handschriftliche Notizen, PDF-Anmerkungen, Textdokumente, Karteikarten und Kalender in einer gemeinsamen Oberfläche. Inhalte werden zunächst lokal auf dem Gerät gespeichert und lassen sich optional über das eigene Google Drive zwischen Geräten synchronisieren.

**[Folio im Browser öffnen](https://blandus.github.io/Folio/)**

## Die Idee

Auf dem iPad handschriftlich mitschreiben, am PC weiterarbeiten und aus den Unterlagen lernen: Folio soll diese Arbeitsschritte zusammenbringen. Der Schwerpunkt liegt auf Stifteingabe, einer übersichtlichen Organisation und der Nutzung eigener Inhalte über mehrere Geräte hinweg.

## Funktionen

### Handschrift und Notizbücher

- Schreiben und Zeichnen mit Apple Pencil, anderen kompatiblen Stiften oder der Maus; Fingereingabe ist optional aktivierbar.
- Einstellbare Stiftfarben, Strichstärken, Druckempfindlichkeit und Strichstabilisierung.
- Textmarker, Radierer, Formen, Lasso-Auswahl, Bilder, Textfelder und Laserpointer.
- Verschiedene Seitenformate und Vorlagen, etwa liniertes, kariertes, gepunktetes oder Cornell-Papier.
- Seitenübersicht, Zoom, mehrere Dokument-Tabs sowie Rückgängig und Wiederholen.

### PDFs und Textdokumente

- PDFs importieren, durchsuchen und mit eigenen Anmerkungen ergänzen.
- Importierte PDFs bleiben als Originaldatei gespeichert; Seiten werden bei Bedarf gerendert.
- Notizbücher als PDF und einzelne Seiten als PNG exportieren.
- Formatierte Textdokumente mit Überschriften, Listen, Aufgaben, Tabellen und Bildern erstellen.
- Textdokumente über den Druckdialog als PDF speichern.

### Karteikarten und Lernplanung

- Karteikarten mit Text, Handschrift und LaTeX-Formeln erstellen.
- Wiederholungen mit einem auf FSRS-6 basierenden Spaced-Repetition-Scheduler planen.
- Fällige Karten, Lernaktivität und die anstehenden Wiederholungen in einer Lernübersicht sehen.
- Tageslimit für neue Karten und gewünschte Behaltensquote einstellen.
- Karten aus Text, Markdown-Tabellen, CSV/TSV oder JSON importieren und als Text exportieren.
- Eine Promptvorlage für die externe Erstellung von Karteikarten mit KI kopieren und die Ergebnisse anschließend importieren.

### Organisation und Kalender

- Notizbücher, Textdokumente und Kartenstapel in Ordnern organisieren.
- Suche, Favoriten, zuletzt geöffnete Dokumente sowie Raster- und Listenansicht nutzen.
- Eigene Termine und wöchentliche Wiederholungen in einer Wochenansicht verwalten.
- ICS-Dateien importieren und Kalender-Abos hinzufügen.
- Google Kalender optional separat verbinden, um Termine anzuzeigen und in berechtigten Kalendern zu bearbeiten.
- Zwischen heller, dunkler und systemabhängiger Darstellung wechseln.

### Synchronisierung und Goodnotes-Austausch

- Dokumente und Lernfortschritt über den Ordner „Folio“ im eigenen Google Drive synchronisieren.
- Änderungen verschiedener Geräte anhand des letzten gemeinsamen Standes zusammenführen; Konflikte werden mit Hinweisen gekennzeichnet.
- Große, synchronisierte Dokumente bei Bedarf nur in Drive behalten und beim Öffnen nachladen.
- `.goodnotes`-Dateien und Goodnotes-Ordnerexporte als ZIP importieren.
- Dokumente experimentell im Goodnotes-Format exportieren oder entsprechende Kopien in Drive erzeugen.

## Nutzung und Speicherung

Folio lässt sich direkt im Browser verwenden. Auf dem iPad kann die Anwendung über Safari zum Home-Bildschirm hinzugefügt werden.

Notizen und Dokumente liegen in IndexedDB, Einstellungen im lokalen Browser-Speicher. Nach dem ersten vollständigen Laden hält ein Service Worker die App-Dateien für die Offline-Nutzung vor. Für Synchronisierung, Google Kalender und das Nachladen ausgelagerter Dokumente wird eine Internetverbindung benötigt. Zusätzliche Bibliotheken und Modelle werden je nach Funktion beim ersten Einsatz geladen.

Die Google-Drive-Anbindung verwendet die Berechtigung `drive.file`. Der Zugriff erfolgt direkt zwischen Browser und Google und ist auf die für Folio zugänglichen App-Dateien beschränkt. Google Kalender wird über eine gesonderte Zustimmung verbunden. Ein eigener Backendserver ist für die Anwendung nicht erforderlich.

Lokale Daten gehören zum jeweiligen Browserprofil und werden beim Löschen der Websitedaten entfernt. Weitere Informationen stehen in der [Datenschutzerklärung](https://blandus.github.io/Folio/datenschutz.html).

## Technischer Aufbau

Folio verwendet HTML, CSS und Vanilla JavaScript mit ES-Modulen. Für den lokalen Start sind weder ein Build-Schritt noch eine npm-Installation erforderlich.

| Bereich | Umsetzung |
| --- | --- |
| Oberfläche und Eingabe | HTML, CSS, Canvas 2D und Pointer Events |
| Lokale Daten | IndexedDB und localStorage |
| Offline-Nutzung | Service Worker und Web-App-Manifest |
| PDFs | PDF.js für Darstellung und Textextraktion, jsPDF für den Export |
| Google-Anbindung | Google Identity Services, Drive API und Calendar API |
| Lernen | FSRS-6-basierte Wiederholungsplanung und LaTeX für Formeln |
| Handschrifterkennung | DE·HTR v2 mit ONNX Runtime Web in einem Web Worker |

Der Code ist nach Aufgaben gegliedert: `editor.js`, `tools.js` und `handwriting.js` behandeln Editor und Stifteingabe; `store.js`, `sync.js` und `merge.js` die Speicherung und Synchronisierung. Karteikarten und Lernplanung liegen in `deck.js`, `srs.js` und `learnplan.js`, die Kalenderfunktionen in `calendar.js` und `ics.js`.

## Lokal starten

Voraussetzungen: Git, Python 3 und ein aktueller Browser.

```bash
git clone https://github.com/Blandus/Folio.git
cd Folio
python -m http.server 8000
```

Anschließend [http://localhost:8000](http://localhost:8000) öffnen. Unter Windows kann alternativ `py -m http.server 8000` verwendet werden.

Für die Google-Anbindung auf einer eigenen Domain oder unter localhost wird eine passende Google-OAuth-Konfiguration mit freigegebener JavaScript-Origin benötigt. Die Client-ID ist in `js/sync.js` hinterlegt und wird auch von der Kalenderanbindung verwendet.

## Entwicklungsstand und Grenzen

Folio ist ein privates Projekt in laufender Entwicklung.

- **Handschrifterkennung ist Beta:** Sie ist standardmäßig deaktiviert und lässt sich unter Einstellungen → Stift einschalten. Das Modell für deutsche Handschrift läuft lokal und ergänzt die Suche. Erkannte Texte werden separat auf dem Gerät gespeichert; die Dokumente bleiben unverändert.
- **Goodnotes-Export ist experimentell:** Die Unterstützung orientiert sich an den im Code abgebildeten Dokumentstrukturen. Eine vollständige Kompatibilität mit allen Goodnotes-Inhalten und Versionen ist nicht zugesichert.
- **Kalender-Abos hängen vom Anbieter ab:** Direkte Abrufe benötigen passende CORS-Freigaben. Der ICS-Parser unterstützt eine Auswahl der iCalendar-Wiederholungsregeln.
- **Exportgrenzen:** Der PDF-Export unterstützt bis zu 500 Seiten pro Vorgang, der Goodnotes-Export bis zu 150 Notizbuchseiten.

## Entwicklung

Folio ist ein persönliches Softwareprojekt von Felix Emmrich. Die Entwicklung erfolgt mit Unterstützung KI-gestützter Entwicklungswerkzeuge. Im Mittelpunkt stehen die Umsetzung konkreter Anforderungen, die Weiterentwicklung der Bedienung und das Zusammenspiel von Stifteingabe, lokaler Speicherung und geräteübergreifender Synchronisierung.

Fehlerberichte und Verbesserungsvorschläge können über die [GitHub Issues](https://github.com/Blandus/Folio/issues) eingereicht werden.
