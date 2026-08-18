PYTHON LEARNING SITE

Folder structure:
Python/
  index.html
  styles.css
  script.js
  lessons/
    lesson1.html
    lesson2.html
    lesson3.html
    ...

DAILY WORKFLOW
1. Add a new file such as lessons/lesson8.html.
2. Keep lesson numbering contiguous (lesson1, lesson2, lesson3...).
3. Give every lesson a unique <title>, ideally a useful <h1>, and preferably:
   <meta name="description" content="...">
   <meta name="lesson-title" content="...">
4. Open index.html. The main page discovers lesson files asynchronously.

IMPORTANT LIMITATION
A browser cannot securely list every file in a server folder by itself. The automatic discovery here probes numbered lesson files. For very large courses, a generated lessons/manifest.json is more efficient and is recommended for maximum performance.

SECURITY
- No API keys, passwords, tokens, or secrets belong in these frontend files.
- Use HTTPS in production.
- Send security headers from your hosting platform/server (CSP, HSTS, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, frame protections).
- Keep lesson pages free of untrusted inline scripts and third-party code unless necessary.
- Escape user-controlled data before inserting it into HTML; script.js does this for lesson metadata.

SEO
This setup includes semantic HTML, responsive metadata, canonical URL, robots metadata, and Course structured data. Search ranking cannot be guaranteed; strong content, internal links, crawlability, backlinks, accessibility, and Core Web Vitals all matter.
