#import "_officehum.typ": *
#let data = json("data.json")
#show: officehum-page

#text(size: 22pt, weight: "bold", fill: primary, data.title)
#if data.at("subtitle", default: none) != none {
  linebreak()
  text(size: 13pt, fill: accent, data.subtitle)
}
#let byline = (data.at("author", default: none), data.at("date", default: none)).filter(item => item != none)
#if byline.len() > 0 {
  linebreak()
  text(size: 9pt, fill: accent, byline.join(" · "))
}

#if data.at("summary", default: none) != none {
  block(fill: primary.lighten(90%), inset: 10pt, radius: 3pt, width: 100%, data.summary)
}

#for section in data.sections {
  heading(level: 1, section.heading)
  for paragraph in section.at("paragraphs", default: ()) {
    par(paragraph)
  }
  if section.at("table", default: none) != none {
    let rows = section.table.rows
    table(
      columns: section.table.columns.len(),
      stroke: 0.4pt + accent.lighten(40%),
      table.header(..section.table.columns.map(column => strong(column))),
      ..rows.flatten(),
    )
  }
}
