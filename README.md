# paper & ink

A personal site as a warm sheet of paper with a dynamic island on top.
Plain HTML, CSS, and JavaScript, no build step. Serve the folder.

- the island idles as your signal, cursor and scroll drawn live. tap it
  and it becomes a music player
- swap the placeholder tracks in the TRACKS array at the top of main.js
  for your own mp3s (drop files next to index.html and use relative
  paths; same-origin tracks also unlock the real spectrum visualizer)
- the github section renders the real contribution graph, recoloured by
  whatever palette is active
- six palettes bottom right, dark paper on the moon, both remembered
- the name writes itself in ink, once per session
- visit emails: `notify.js` pings a Google Apps Script web app once per
  session and it emails you. setup (one time, ~3 minutes):
  1. go to script.google.com signed in as the gmail you want mail at,
     make a new project, replace its contents with `notify/Code.gs`
  2. Deploy > New deployment > type "Web app", execute as **Me**, who has
     access **Anyone**. approve the permissions prompt (it asks to send
     mail as you). copy the web app URL (ends in `/exec`)
  3. paste that URL into `NOTIFY_ENDPOINT` at the top of `notify.js`, push
  4. open the site once with `?me` on each of your own devices so your
     own visits are ignored
  edits to Code.gs later need Deploy > Manage deployments > edit > new
  version, or the live URL keeps running the old code
