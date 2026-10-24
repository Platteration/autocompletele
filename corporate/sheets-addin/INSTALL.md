# Installing extle in Excel and Google Sheets

This guide turns this folder into what an organisation installs: a folder that
an HTTPS host serves for Excel, with a manifest made for the organisation and
the ribbon icons, and the files of an Apps Script project for Google Sheets.

What was checked here, and what was not:

- The package build was run and is tested (`test/package.test.js`): the
  manifest is well-formed XML, its values come from the configuration, every
  file it names is in the package, the icons are valid PNG files of their
  sizes, and the same configuration gives the same files.
- Nothing in this guide was run against Excel, Microsoft 365, Google Sheets or
  Google Workspace. No host was asked to accept the package, and Microsoft's
  manifest validator was not run (it sends the manifest to a Microsoft service
  this build environment cannot reach). Every step that depends on a host is
  marked **Not verified here**. The steps follow Microsoft's and Google's
  documentation, linked where a step depends on it. Two parts have no source
  page: the content types and the `curl` check in section 2, which are general
  web practice, and the pasting steps in section 6. Microsoft's pages were read
  from their published sources. Google's pages could not be opened here; the Google steps come from search
  summaries of the pages linked, and from the clasp README.

## 1. Build the package

You need Node.js 22.2 or later (the version `corporate/package.json` asks
for). The build installs nothing and uses no network.

1. Copy the example configuration. Git ignores `extle.config.json`, so your
   values stay out of the repository.

   ```
   cd corporate/sheets-addin
   cp extle.config.example.json extle.config.json
   ```

2. Make the add-in's GUID once, and keep it for every later version:

   ```
   node -e "console.log(crypto.randomUUID())"
   ```

3. Fill in the file, with that GUID as `id`:

   ```json
   {
     "id": "the GUID from step 2",
     "baseUrl": "https://addins.example.org/extle/",
     "providerName": "Example Logistics Ltd",
     "version": "1.0.0.0",
     "supportUrl": "https://intranet.example.org/help/extle"
   }
   ```

   | Key | What it is | Rules the build enforces |
   | --- | --- | --- |
   | `id` | The add-in's identity in Office. Make it once and keep it for every later version. | A GUID, hyphenated, no braces ([Id](https://learn.microsoft.com/en-us/javascript/api/manifest/id)). Not one of the placeholders the build knows (the example's GUID, the all-zero GUID, and the sample an earlier version of this guide showed), except with `--dev`. Make one with `node -e "console.log(crypto.randomUUID())"`. |
   | `baseUrl` | The address the `excel` folder is served at, folder and all. | `https://`. A trailing `/` is added when missing. No `?` or `#`, not even a bare one at the end, and no user name or password. The folder, not a file in it: a last part ending in `.html`, `.htm`, `.xml`, `.js`, `.css` or `.png` with no closing `/` is refused (`.../extle/taskpane.html` is the page; `.../extle/1.0.0.0` is a folder). Not an address of this computer, except with `--dev`: `localhost` or a `.localhost` name (also with a final dot, `localhost.`), `127.x.x.x`, `0.0.0.0`, `[::1]`, `[::]`, or `127.x.x.x` or `0.0.0.0` written as IPv6 (`[::ffff:127.0.0.1]`). `baseUrl` plus `taskpane.html` at most 2018 characters ([SourceLocation](https://learn.microsoft.com/en-us/javascript/api/manifest/sourcelocation)). |
   | `providerName` | Your organisation's name, as the add-in's provider. | At most 125 characters ([ProviderName](https://learn.microsoft.com/en-us/javascript/api/manifest/providername)). |
   | `version` | The manifest's version. | 1 to 4 numbers of at most 5 digits, separated by dots, such as `1.0.0.0` ([Version](https://learn.microsoft.com/en-us/javascript/api/manifest/version)). No leading zeros (`01`, `1.00`): Microsoft's page does not say whether the manifest's schema takes them, so the build keeps to plain numbers. |
   | `supportUrl` | A page where people get help with extle. | `https://`, the same rules as `baseUrl` for `localhost`. A query string is allowed. At most 2048 characters as the manifest holds it (a space counts as the three characters of `%20`): Microsoft gives that limit for the manifest's URLs ([Resources](https://learn.microsoft.com/en-us/javascript/api/manifest/resources)); the [SupportUrl](https://learn.microsoft.com/en-us/javascript/api/manifest/supporturl) page gives none of its own. |
   | `displayName` | Optional. The add-in's name in Excel's list of add-ins, and the label of its ribbon group and button. The pane itself, its messages and Google Sheets keep the name extle. Default `extle`. | At most 120 characters: the ribbon button reads "Open " and the name, and holds 125 ([Resources](https://learn.microsoft.com/en-us/javascript/api/manifest/resources), [DisplayName](https://learn.microsoft.com/en-us/javascript/api/manifest/displayname)). |
   | `description` | Optional. Default "extle: column-aware completion in Excel from your organisation's vocabularies, and blocks and formulas by trigger." | At most 250 characters ([Description](https://learn.microsoft.com/en-us/javascript/api/manifest/description)). |

   The three texts must not be empty or hold a control character (a tab or a
   line break, say), U+FFFE or U+FFFF. Any other key is refused, so a misspelt
   key (`baseURL`) does not pass unnoticed. Every value is XML-escaped in the
   manifest. A file saved with a UTF-8 byte-order mark, as some Windows editors
   save it, is read as if the mark were not there.

4. Build:

   ```
   node build.js --package extle.config.json              # writes ./package/
   node build.js --package extle.config.json --out ~/extle-1.0.0.0
   ```

   When the configuration is refused, the build lists the problems it finds
   in every value, writes nothing and exits with status 1. A value of the
   wrong kind (a number where a text belongs) or a URL that cannot be read
   gets one problem only, since nothing more can be checked in it. Write
   `--package FILE` with a space: an argument the build does not know, such
   as `--package=FILE`, is refused in the same way.

The package:

```
package/
  excel/                 everything the HTTPS host serves at baseUrl
    manifest.xml         made from manifest.template.xml and your configuration
    taskpane.html        the task pane page; loads Office.js from Microsoft's CDN, then the files below
    taskpane.js, pane.js, pane.css
    dist/sheets-core.js  the core bundle
    assets/icon-16.png, icon-32.png, icon-64.png, icon-80.png
  apps-script/           the Apps Script project, for clasp push or pasting
    Code.gs, Sidebar.html, sheets-core.html, pane.html, appsscript.json
```

The icons are drawn by the build: a white e on a rounded square in the pane's
accent colour (`#2457c5`, 6.5:1 against white). Microsoft asks for a 32 by 32
`IconUrl` and a 64 by 64 `HighResolutionIconUrl` for a task pane add-in, and
16, 32 and 80 pixel images for a ribbon button
([IconUrl](https://learn.microsoft.com/en-us/javascript/api/manifest/iconurl),
[HighResolutionIconUrl](https://learn.microsoft.com/en-us/javascript/api/manifest/highresolutioniconurl),
[Icon](https://learn.microsoft.com/en-us/javascript/api/manifest/icon)).
**Not verified here:** how they look in Excel's ribbon, in light and dark
Office themes.

The manifest asks for ExcelApi 1.7, which the pane needs to load. List
validation (ExcelApi 1.8) and the spill check (ExcelApi 1.12) are checked at
run time: the pane checks both when it starts and leaves list validation out
where Excel lacks 1.8, and checks 1.12 again before each replacement
(README.md, "A strict column"). It lists no `AppDomains`:
everything is served from the `baseUrl` host, and Microsoft says listing the
`SourceLocation` domain has no effect
([AppDomain](https://learn.microsoft.com/en-us/javascript/api/manifest/appdomain)).

A rebuild into the same folder writes its own files again and deletes
nothing. A file it did not write (left from an older version, say) stays and
is listed after the build, so you can remove it before you upload. In
`apps-script/`, names starting with a dot are not listed: clasp ignores them,
and `.clasp.json` (below) lives there. In `excel/` they are listed (a
`.htaccess`, say), since a host may serve them.

The same sources and configuration give the same text files, byte for byte.
The icons are compressed with Node's zlib, so another Node.js version may give
other bytes for the same pixels.

### A development package

`--dev` builds a package for testing on your own computer. It accepts the
example's placeholder GUID, `localhost` addresses, and `http://` for
`localhost` only. The manifest then says it is a development package.

```
node build.js --package extle.config.example.json --dev   # for https://localhost:3000/
```

Serve the `excel` folder at `https://localhost:3000/` with a certificate your
computer trusts. Microsoft's `SourceLocation` reference says the source
location must be an HTTPS address, and Office on the web needs HTTPS, so an
`http://localhost` package may not load at all
([SourceLocation](https://learn.microsoft.com/en-us/javascript/api/manifest/sourcelocation),
[sideloading on Windows](https://learn.microsoft.com/en-us/office/dev/add-ins/testing/create-a-network-shared-folder-catalog-for-task-pane-and-content-add-ins)).
**Not verified here.**

## 2. Host the excel folder

Use an HTTPS host that serves static files and lets you meet every point
below, your own web server or a static site service. A host that adds a
`Cache-Control` header to every response, with no way to leave it off the
icons, cannot serve them (see below). Copy the whole `excel` folder so that
`baseUrl` plus `taskpane.html` is the task pane page.

- The certificate must be trusted on every computer that runs extle.
- Serve the files with these content types:

  | Files | Content type |
  | --- | --- |
  | `.html` | `text/html; charset=utf-8` |
  | `.js` | `text/javascript; charset=utf-8` |
  | `.css` | `text/css; charset=utf-8` |
  | `.png` | `image/png` |
  | `manifest.xml`, only if you give the admin center its URL (below) | `application/xml` |

- Send no `Cache-Control` header with the icons. Microsoft says such a header
  makes Office show a default image instead, and that a changed icon needs a
  new URL ([Image](https://learn.microsoft.com/en-us/javascript/api/manifest/image)).
- The task pane page loads Office.js from
  `https://appsforoffice.microsoft.com/lib/1/hosted/office.js`, and Office.js
  loads further files of its own from there (its strings and a script for the
  kind of Excel it runs in), so computers must reach
  `https://appsforoffice.microsoft.com` too. The pane's own scripts fetch
  nothing else. The further files were seen in the npm copy of Office.js
  (`@microsoft/office-js` 1.1.110); the CDN itself could not be reached here.
- Check that each file answers, for example
  `curl -I https://addins.example.org/extle/dist/sheets-core.js` should give
  status 200 and `text/javascript`.

**Not verified here:** any host. Whether a host that asks people to sign in
before it serves the files works in Excel's task pane was not checked.

## 3. Try it in Excel (sideload)

Sideloading installs the add-in for one person, for testing. The add-in's
files stay on the host; only `manifest.xml` is copied.

**Windows**, from a network share
([Microsoft](https://learn.microsoft.com/en-us/office/dev/add-ins/testing/create-a-network-shared-folder-catalog-for-task-pane-and-content-add-ins)):

1. Share a folder on the network and put `excel/manifest.xml` in it.
2. In Excel: **File** > **Options** > **Trust Center** > **Trust Center
   Settings** > **Trusted Add-in Catalogs**. Enter the share's network path
   (`\\server\share`) as **Catalog Url**, choose **Add catalog**, tick **Show
   in Menu** and choose **OK**. Close and reopen Excel.
3. **Home** > **Add-ins** > **Advanced**, then **SHARED FOLDER**, select
   **extle** (or your `displayName`) and choose **Add**.

Microsoft says a network share is for testing only, not for production.

**Mac** ([Microsoft](https://learn.microsoft.com/en-us/office/dev/add-ins/testing/sideload-an-office-add-in-on-mac)):

1. In Finder, **Go to folder** (Cmd+Shift+G):
   `/Users/<username>/Library/Containers/com.microsoft.Excel/Data/Documents/wef`.
   Create the `wef` folder if it is not there.
2. Copy `excel/manifest.xml` into it.
3. Open Excel (restart it if it is running), open a workbook, then **Home** >
   **Add-ins** and select extle (or your `displayName`).

**Excel on the web** ([Microsoft](https://learn.microsoft.com/en-us/office/dev/add-ins/testing/sideload-office-add-ins-for-testing)):

1. Open a workbook in Excel on the web.
2. **Home** > **Add-ins** > **More Settings**, then **Upload My Add-in**.
3. Browse to `excel/manifest.xml` and choose **Upload**.

Microsoft says the uploaded manifest is kept in the browser's storage, so
clearing the cache or using another browser means uploading it again.

Once loaded, the Home tab has an **extle** group with an **Open extle**
button that opens the pane (with a `displayName`, the group has that name and
the button reads "Open" and that name). To remove a sideloaded add-in on
Windows or Mac, clear the Office cache
([Microsoft](https://learn.microsoft.com/en-us/office/dev/add-ins/testing/clear-cache)).
Then go through the checks in README.md, "Not verified here".

**Not verified here:** every step of this section.

## 4. Deploy to the organisation (Microsoft 365)

An admin deploys the add-in from the Microsoft 365 admin center, under
**Integrated apps**
([Microsoft](https://learn.microsoft.com/en-us/microsoft-365/admin/manage/office-addins)):

1. **Settings** > **Integrated apps** > **Upload custom apps**.
2. **App type**: **Office Add-in**. Upload `excel/manifest.xml`, or give the
   URL where the host serves it and choose **Validate**. The manifest may be
   at most 512 KB (extle's is about 4 KB).
3. **Next**, then **Add users**: **Entire organization**, **Specific
   users/groups** or **Just me**. Start with yourself or a small group.
4. **Next** shows the permissions the add-in asks for. extle asks for
   `ReadWriteDocument`: it reads and writes the workbook it is opened in.
   Accept them if asked; Microsoft says only a global administrator can give
   consent.
5. **Next**, then **Finish deployment**.

Microsoft's conditions, from the same page: Exchange admins and global admins
can deploy; people need a Microsoft 365 business or enterprise licence, sign
in to Office with their work account and have an Exchange Online mailbox;
Excel on Windows (version 1704 or later), on Mac (15.34 or later) and on the
web, not on iPad. It can take up to 24 hours before the add-in shows for
everyone
([Centralized Deployment](https://learn.microsoft.com/en-us/microsoft-365/admin/manage/centralized-deployment-of-add-ins)).
Organisations in sovereign or government clouds use Centralized Deployment
instead of Integrated apps
([Microsoft](https://learn.microsoft.com/en-us/office/dev/add-ins/publish/publish)).

**Not verified here:** every step of this section.

## 5. Update Excel to a new version

1. Raise `version` in `extle.config.json`. Keep the same `id`. Microsoft:
   "Whenever you make a change to the manifest, you must raise the version
   number of the manifest"
   ([Microsoft](https://learn.microsoft.com/en-us/office/dev/add-ins/publish/publish)).
2. Build into the same folder as before and read the list of files left in
   place.
3. Copy the new `excel` folder to the host. The pages and scripts are read
   from the host, so the new ones apply when a pane next loads them. How long
   Office or a browser keeps an older copy depends on your host's cache
   headers; that was not checked here.
4. In **Integrated apps**, upload the new manifest. Microsoft: for an add-in
   an admin uploaded, "the admin must upload the new manifest file to support
   metadata changes. The next time a user starts the relevant Microsoft 365
   productivity application, the add-in will update"
   ([Microsoft](https://learn.microsoft.com/en-us/microsoft-365/admin/manage/office-addins)).
   The buttons for replacing a custom app's manifest were not confirmed here.
5. A change to the permissions needs consent again. extle's permission has not
   changed.

The icon file names do not change between versions, and Office keeps icons it
has loaded. To get a changed icon to people, serve the version from a new
folder (for example `https://addins.example.org/extle/1.1.0.0/`) and set
`baseUrl` to it.

**Not verified here:** every step of this section.

## 6. Google Sheets: the Apps Script project

There are two kinds of project:

- **Bound**: made from a spreadsheet with **Extensions** > **Apps Script**.
  The script belongs to that spreadsheet and its menu shows only there. Good
  for trying extle out.
- **Standalone**: made at [script.google.com](https://script.google.com) with
  **New project**. Google's guide to building editor add-ons describes an
  editor add-on as a standalone project, so use one to deploy to the domain
  ([Google](https://developers.google.com/workspace/add-ons/how-tos/building-editor-addons)).

Name the project **extle** (click its title, which reads "Untitled project"
for a new one). Then put the files of `package/apps-script/` into the
project, by pasting or with clasp.

**Pasting**:

1. **Project Settings** > tick **Show "appsscript.json" manifest file in
   editor**.
2. Replace the project's `appsscript.json` with the package's.
3. Replace the script file `Code.gs` with the package's.
4. Add three HTML files named `Sidebar`, `sheets-core` and `pane` (the editor
   adds `.html`) and paste each file's contents. `sheets-core.html` is about
   80 KB and `pane.html` about 60 KB.
5. Save.

**clasp** ([clasp README](https://github.com/google/clasp)):

1. `npm install -g @google/clasp`, then enable the Apps Script API at
   <https://script.google.com/home/usersettings> and run `clasp login`. If
   your organisation restricts third-party apps, an admin may have to allow
   clasp first (its README names the client id).
2. In `package/apps-script/`, create `.clasp.json` with the project's script
   id (**Project Settings** > **IDs**):

   ```json
   { "scriptId": "the script id" }
   ```

   A rebuild leaves this file alone.
3. `clasp push`. It replaces every file of the online project with the
   folder's. It may ask before it replaces the project's manifest; answer yes,
   or use `clasp push --force`.

**Not verified here:** every step of this section; clasp was not run.

## 7. Try it in Google Sheets

- **Bound project**: reload the spreadsheet. The **extle** menu has **Open
  sidebar**. The first time, Google asks the person to authorize the script.
- **As an editor add-on**: in the Apps Script editor, **Deploy** > **Test
  deployments**, choose the type **Editor add-on**, pick a test spreadsheet
  and the add-on's starting state (installed, or installed and enabled), save
  the test, select it and choose **Execute**
  ([Google](https://developers.google.com/workspace/add-ons/how-tos/testing-editor-addons)).
  A published add-on puts its item under **Extensions**, under the add-on's
  name, not in an **extle** menu of its own: Google says the menu's caption
  is ignored for a published add-on
  ([Ui](https://developers.google.com/apps-script/reference/base/ui)).

`Code.gs` builds the menu in `onOpen`, and in `onInstall`, which Google runs
instead of `onOpen` when the add-on is installed into a spreadsheet that is
already open
([editor add-on triggers](https://developers.google.com/workspace/add-ons/concepts/editor-triggers)).
Google says `onInstall` does not run for an install from the Marketplace
website; the menu then appears when the spreadsheet is next opened. The menu
uses no service that needs authorization, so it is built the same way in
every authorization mode
([authorization lifecycle](https://developers.google.com/workspace/add-ons/concepts/editor-auth-lifecycle)).

**Not verified here:** every step of this section.

## 8. Deploy to the domain (Google Workspace)

Publish the standalone project as a private editor add-on, then install it
for the domain. From Google's pages
([publishing](https://developers.google.com/workspace/add-ons/how-tos/publish-add-on-overview),
[Marketplace SDK](https://developers.google.com/workspace/marketplace/enable-configure-sdk)):

1. Link the project to a standard Google Cloud project (**Project Settings** >
   **Google Cloud Platform (GCP) Project**). Google says the default project
   cannot be used to publish.
2. In the Apps Script editor, **Deploy** > **New deployment**, and note the
   version number (**Deploy** > **Manage deployments**, under
   **Configuration**).
3. In the Cloud project, enable the **Google Workspace Marketplace SDK** and
   fill in its **App Configuration**: visibility **Private** (Google says
   visibility cannot be changed later), the installation settings, the
   integration as a Sheets editor add-on with the script id and the version
   number, and the two OAuth scopes below. Give the add-on the name **extle**
   in both the App Configuration and the **Store Listing**: a published
   add-on's item under **Extensions** carries that name (section 7). Then
   publish. A third-party guide adds that the OAuth consent screen's audience
   should be **Internal**; that was not confirmed on Google's pages.
4. An admin installs it for everyone or for chosen organisational units or
   groups: Admin console > **Apps** > **Google Workspace Marketplace apps** >
   **Apps list** > **Install app**, then **Admin install**
   ([Google](https://support.google.com/a/answer/172482)). Google says changes
   can take up to 24 hours.

The Store Listing asks for icons. Their required sizes were not confirmed
here, and the build makes no icon for Google; `excel/assets/icon-32.png` is
32 by 32.

### What people are asked to approve

`appsscript.json` lists the scopes, so Google asks for these two and no
others ([manifest](https://developers.google.com/apps-script/manifest),
[scopes](https://developers.google.com/apps-script/concepts/scopes)):

- `https://www.googleapis.com/auth/spreadsheets.currentonly`: the spreadsheet
  the add-on runs in, and no other
  ([add-on scopes](https://developers.google.com/workspace/add-ons/concepts/gsuite-scopes)).
  extle reads the selected cell, its column and header, writes completions,
  blocks and formulas, replaces aliases and sets list validation in that
  spreadsheet.
- `https://www.googleapis.com/auth/script.container.ui`: the menu and the
  sidebar inside Sheets.

`Code.gs` also keeps the configuration in the document's properties and the
usage counts in the person's user properties (`PropertiesService`). No scope
was added for them; whether the Properties service needs one could not be
confirmed on Google's pages. If Google refuses those calls, the sidebar says
it could not read the saved configuration, or that it keeps the counts for
this session only, with Google's message. The wording Google shows for each
scope was not confirmed here.

### Updating Google to a new version

1. Push or paste the new files.
2. **Deploy** > **Manage deployments**, edit the active deployment, choose
   **New version** and **Deploy**. Google warns against **New deployment**
   here: it makes a new deployment id.
3. In the Marketplace SDK's **App Configuration**, enter the new version
   number and save
   ([Google](https://developers.google.com/workspace/add-ons/how-tos/update-published-add-on)).
4. A new scope must also be added in the Marketplace SDK, and people approve
   it the next time they use the add-on. extle's scopes have not changed.

A bound project only needs the new files.

**Not verified here:** every step of this section.
