const today = () => new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });

export const TEMPLATES = [
  {
    id: 'blank',
    name: 'Blank document',
    title: 'Untitled document',
    html: () => '<p></p>',
  },
  {
    id: 'letter',
    name: 'Letter',
    title: 'Letter',
    html: () => `
<p>Your Name<br>123 Street Address<br>City, ST 00000<br>you@example.com</p>
<p>${today()}</p>
<p>Recipient Name<br>Title<br>Company<br>Street Address<br>City, ST 00000</p>
<p>Dear Recipient Name,</p>
<p>To get started right away, just click any placeholder text (such as this) and start typing to replace it with your own.</p>
<p>Want to insert a picture from your files or add a table? Go to the Insert tab on the ribbon and choose the option you need.</p>
<p>Use the styles gallery on the Home tab to format your text with a single click.</p>
<p>Sincerely,</p>
<p><br></p>
<p>Your Name</p>`,
  },
  {
    id: 'resume',
    name: 'Résumé',
    title: 'Résumé',
    html: () => `
<p data-style="title">Your Name</p>
<p data-style="subtitle">Street Address · City, ST 00000 · (555) 555-0100 · you@example.com</p>
<h1>Objective</h1>
<p>Replace this sentence with a short summary of your career goals and what makes you a great fit for the role.</p>
<h1>Experience</h1>
<h2>Job Title · Company</h2>
<p data-style="no-spacing"><em>2022 – Present</em></p>
<ul><li><p>Describe your responsibilities and achievements in terms of impact and results.</p></li><li><p>Use examples, but keep it short.</p></li></ul>
<h2>Job Title · Company</h2>
<p data-style="no-spacing"><em>2019 – 2022</em></p>
<ul><li><p>Led a cross-functional project that improved a key metric by 25%.</p></li></ul>
<h1>Education</h1>
<h2>Degree · School</h2>
<p>You might want to include your GPA and a summary of relevant coursework, awards, and honors.</p>
<h1>Skills</h1>
<ul><li><p>List your strengths relevant to the role you're applying for</p></li><li><p>List one of your strengths</p></li></ul>`,
  },
  {
    id: 'report',
    name: 'Report',
    title: 'Report',
    html: () => `
<p data-style="title">Report Title</p>
<p data-style="subtitle">${today()}</p>
<nav data-toc></nav>
<h1>Introduction</h1>
<p>Use this section to introduce the purpose and scope of the report. The table of contents above updates automatically as you add headings.</p>
<h1>Findings</h1>
<h2>Key metric</h2>
<p>Summarize what the data shows. You can add tables from the Insert tab.</p>
<table><tbody><tr><th><p>Quarter</p></th><th><p>Revenue</p></th><th><p>Growth</p></th></tr><tr><td><p>Q1</p></td><td><p>$1.2M</p></td><td><p>4%</p></td></tr><tr><td><p>Q2</p></td><td><p>$1.4M</p></td><td><p>17%</p></td></tr></tbody></table>
<h2>Observations</h2>
<ul><li><p>First observation</p></li><li><p>Second observation</p></li></ul>
<h1>Conclusion</h1>
<p>Wrap up with the main takeaways and recommended next steps.</p>`,
  },
  {
    id: 'meeting',
    name: 'Meeting notes',
    title: 'Meeting notes',
    html: () => `
<h1>Meeting notes</h1>
<p><strong>Date:</strong> ${today()}<br><strong>Attendees:</strong> Name, Name, Name</p>
<h2>Agenda</h2>
<ol><li><p>Review of last week's action items</p></li><li><p>Project updates</p></li><li><p>Open discussion</p></li></ol>
<h2>Notes</h2>
<p>Capture the important points of the discussion here.</p>
<h2>Action items</h2>
<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>Owner — task description</p></li><li data-type="taskItem" data-checked="false"><p>Owner — task description</p></li></ul>`,
  },
  {
    id: 'essay',
    name: 'Essay',
    title: 'Essay',
    html: () => `
<p data-style="no-spacing" style="line-height: 2">Your Name</p>
<p data-style="no-spacing" style="line-height: 2">Instructor Name</p>
<p data-style="no-spacing" style="line-height: 2">Course Number</p>
<p data-style="no-spacing" style="line-height: 2">${today()}</p>
<p style="text-align: center; line-height: 2; margin-bottom: 0pt">Essay Title</p>
<p style="line-height: 2; text-indent: 48px; margin-bottom: 0pt">Begin your essay here. This template uses double spacing and a half-inch first-line indent, as most academic style guides require.</p>
<p style="line-height: 2; text-indent: 48px; margin-bottom: 0pt">Each new paragraph is indented automatically. Press Enter to start the next one.</p>`,
    settings: { margins: { top: 96, right: 96, bottom: 96, left: 96 } },
  },
];
