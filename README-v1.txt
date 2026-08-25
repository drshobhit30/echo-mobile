ECHO NEXUS — VERSION 1.0
Frozen 25 August 2026.

WHAT THIS IS
The complete working system as of the freeze: desktop app, mobile companion,
icons, manifest, and the full test suite. Everything built up to this point.

Desktop build : v1.0 (2026-08-25-lab+38)
Mobile cache  : echo-nexus-v28
Tests         : 37 suites, all passing at the freeze

WHY IT EXISTS
This is the fallback. If a later version misbehaves, these files restore a
whole working system — not just a slightly older file. Keep this folder
somewhere it CANNOT be overwritten by a deploy: a v1 folder in Drive, and on
the pen drive.

TO GO BACK TO IT
Desktop : copy echo-dental-collection-log.html over the live file on BOTH
          machines.
Mobile  : copy index.html, sw.js, manifest.json and the four icons, then
          remove and re-add the home-screen shortcut.

Nothing here touches your clinic DATA. The files in this folder are the
program; your records live in the storage folder and are untouched by a
version change in either direction.

TO CHECK A FILE IS THIS VERSION
Desktop : the header reads "Clinic Operations Platform - v1.0".
Mobile  : the same, under the app name at the top of the screen.
Tests   : unzip tests.zip beside the files and run
          bash tests/run_suite.sh

WHAT IS IN VERSION 1
Reception and admin operations; billing with cancellation and credit notes;
day close with cross-machine locking; lab case tracking with holds; treatment
follow-ups; treatment estimates; patient records, notes and timeline; ortho;
reports; backup and restore; the read-only mobile companion.

KNOWN LIMITS AT THE FREEZE
- The restore drill has never been performed. Backups have been proven to
  COPY, not to RESTORE. This is the most important untested thing in the
  system.
- Patient phone numbers are not stored; the directory holds ID and name only.
- No appointment system, and so no appointment reminders.
- Estimates appear on the phone read-only; they are edited on the desktop.
