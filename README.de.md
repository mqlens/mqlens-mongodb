# MQLens

[English](README.md) · **Deutsch** · [简体中文](README.zh-CN.md)

**MongoDB-Daten durchsuchen, abfragen und verstehen.** Ein kostenloser, quelloffener Desktop-Arbeitsbereich für macOS, Windows und Linux.

[![CI](https://github.com/mqlens/mqlens-mongodb/actions/workflows/ci.yml/badge.svg)](https://github.com/mqlens/mqlens-mongodb/actions/workflows/ci.yml)
[![Coverage](https://img.shields.io/badge/coverage-enabled-brightgreen.svg)](.github/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/mqlens/mqlens-mongodb)](https://github.com/mqlens/mqlens-mongodb/releases)
[![Downloads](https://img.shields.io/github/downloads/mqlens/mqlens-mongodb/total)](https://github.com/mqlens/mqlens-mongodb/releases)
[![Stars](https://img.shields.io/github/stars/mqlens/mqlens-mongodb?style=flat)](https://github.com/mqlens/mqlens-mongodb/stargazers)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

<br />

Verbinde lokale MongoDB-Datenbanken, selbst gehostete Installationen oder MongoDB Atlas. Durchsuche Dokumente, erstelle Abfragen und prüfe Ergebnisse in einem Arbeitsbereich. Mit Tabs und geteilten Ansichten kannst du mehrere Collections nebeneinander bearbeiten.

Starte mit Tabellen- und JSON-Ansichten und nutze bei Bedarf Aggregationen, Ausführungspläne, Schemaanalyse oder die integrierte Shell. Du brauchst kein MQLens-Konto; KI-Unterstützung ist optional.

**[MQLens herunterladen](https://mqlens.com/#download)** · [Demo ansehen](https://mqlens.com/demo/) · [Dokumentation](https://mqlens.com/docs/) · [Website](https://mqlens.com)

<br />

[![MQLens mit zwei nebeneinander geöffneten Collections](website/public/screenshots/mqlens-workspace.png)](https://mqlens.com/demo/)

*Screenshots und Demos verwenden Beispieldaten, einschließlich beispielhafter Abfrageergebnisse und Ausführungsstatistiken.*

## Von der Collection zur Antwort

- **Dokumente erkunden.** Zwischen Tabellen-, Baum- und JSON-Ansicht wechseln; Ergebnisse filtern, sortieren, bearbeiten und exportieren.
- **Abfragen verstehen.** Aggregationspipelines erstellen, visuelle Ausführungspläne prüfen und Indizes verwalten.
- **Den Arbeitsbereich anpassen.** Ansichten aufteilen, Tabs in eigene Fenster verschieben und die Sitzung wiederherstellen.
- **Datenbanken verbinden.** MongoDB-Verbindungszeichenfolgen, SSH-Tunnel, TLS und unterstützte Anmeldeverfahren nutzen.
- **Mit Schutzfunktionen arbeiten.** Verbindungen schreibgeschützt öffnen oder Bestätigungen für destruktive Aktionen aktivieren. Zugangsdaten werden lokal verschlüsselt und durch ein Master-Passwort geschützt.
- **KI nach Bedarf nutzen.** Generierte MQL-Abfragen vor dem Ausführen bearbeiten oder ausgewählte Verbindungen ausdrücklich für einen MCP-kompatiblen Agenten freigeben.

[Alle Funktionen ansehen](https://mqlens.com/features/), darunter Schemaanalyse, GridFS, Testdatengenerierung, Import/Export und die integrierte `mongosh`-Shell.

## MQLens Server — demnächst verfügbar

Ein selbst hostbarer Team-Backenddienst mit zentral verwalteten MongoDB-Zugangsdaten, Zugriffskontrollen und Audit-Protokollen ist geplant. MQLens Server wird ein separates kostenpflichtiges Produkt; die Desktop-App bleibt kostenlos und quelloffen. [Mehr über MQLens Server](https://mqlens.com/mqlens-server/) oder [das Projekt verfolgen](https://github.com/mqlens/mqlens-server).

## Installieren und die erste Abfrage ausführen

Lade die [aktuelle Version](https://github.com/mqlens/mqlens-mongodb/releases/latest) herunter oder wähle auf der [Downloadseite](https://mqlens.com/#download) das passende Paket.

| Plattform | Paket | Erste Schritte |
| --- | --- | --- |
| macOS | `.dmg` für Apple Silicon oder Intel | Das Image öffnen und MQLens in den Programme-Ordner ziehen. |
| Windows | `.exe` oder `.msi` für x64 | Installation ausführen und MQLens über das Startmenü öffnen. |
| Linux | `.deb`, `.rpm` oder `.AppImage` | Paketmanager verwenden oder die AppImage-Datei ausführbar machen. |

1. MQLens öffnen und den lokalen Tresor für Zugangsdaten einrichten.
2. Eine MongoDB-Verbindung hinzufügen oder die integrierten Beispieldaten erkunden.
3. Eine Collection öffnen, einen Filter eingeben und die Abfrage ausführen.

Weitere Informationen findest du in der [Installations- und Verbindungshilfe](https://mqlens.com/docs/). Die optionale integrierte Shell setzt eine Installation von [`mongosh`](https://www.mongodb.com/docs/mongodb-shell/) voraus; normale GUI-Abfragen benötigen sie nicht.

## Ein kurzer Einblick

[![MQLens zeigt Beispieldokumente in Tabellen- und Baumansicht](assets/demo.gif)](https://mqlens.com/demo/)

[Die vollständige Demo und Arbeitsabläufe ansehen](https://mqlens.com/demo/).

| Eine Aggregation erstellen | Einen Ausführungsplan lesen |
| --- | --- |
| [![Aggregationsstufen mit Beispielergebnissen](website/public/screenshots/mqlens-aggregation.png)](https://mqlens.com/guides/mongodb-aggregation-gui/) | [![Ausführungsplan mit beispielhaften Statistiken](website/public/screenshots/mqlens-explain-plan.png)](https://mqlens.com/guides/read-mongodb-explain-plan/) |

## Vertrauen und Datenschutz

- Kein Konto erforderlich; keine App-Telemetrie.
- Zugangsdaten und Einstellungen werden lokal mit AES-256-GCM und einem durch Argon2id abgeleiteten Schlüssel verschlüsselt.
- Schreibschutz und Bestätigungen für destruktive Aktionen ergänzen MongoDB-Berechtigungen und Backups.
- KI ist optional. Konfigurierte Anbieter oder Agenten können Prompts, Schemainformationen und Werkzeugergebnisse erhalten. Ein im Backend gespeicherter API-Schlüssel bedeutet nicht, dass die KI-Verarbeitung auf deinem Gerät bleibt.
- MCP ist standardmäßig deaktiviert, wird pro Verbindung freigegeben und bietet Bestätigungen für Schreibvorgänge. Lies vor der Aktivierung die [MCP-Referenz](docs/mcp-tools.md).
- Releases enthalten Informationen zur Überprüfung. Siehe [Downloads überprüfen](docs/verifying-downloads.md) und die [Sicherheitsrichtlinie](.github/SECURITY.md).

Du vergleichst Werkzeuge? Hier findest du die Vergleiche mit [MongoDB Compass](https://mqlens.com/compare/mongodb-compass-alternative/) und [Studio 3T](https://mqlens.com/compare/studio-3t-alternative/).

## Deine Sprache

Die App unterstützt Englisch, Deutsch und vereinfachtes Chinesisch. Wähle deine Sprache in den Einstellungen. Dieses README ist auch auf [Englisch](README.md) und [简体中文](README.zh-CN.md) verfügbar. Verlinkte Webseiten und technische Anleitungen sind derzeit auf Englisch.

## Mitwirken

Die Oberfläche von MQLens verwendet React und TypeScript, das Backend Tauri und Rust. Fehlerberichte, Dokumentationskorrekturen, Übersetzungen und Codebeiträge sind willkommen.

- [Entwicklungsumgebung und Testbefehle](docs/development.md)
- [Beitragsrichtlinien](.github/CONTRIBUTING.md) und [Übersetzungsleitfaden](docs/CONTRIBUTING-i18n.md)
- [Lokale Demo-Datenbank](docs/demo-database.md)
- [Aufgaben für den Einstieg](https://github.com/mqlens/mqlens-mongodb/labels/good%20first%20issue) und [Roadmap](docs/ROADMAP.md)
- [Fehler melden](https://github.com/mqlens/mqlens-mongodb/issues/new?template=bug_report.yml)

## Lizenz

[Apache-2.0](LICENSE). Frei nutzen, prüfen und verbessern.
