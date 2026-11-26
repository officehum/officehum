#import "_officehum.typ": *
#let data = json("data.json")
#show: officehum-page

#text(size: 20pt, weight: "bold", fill: primary)[Memo]
#v(0.4cm)
#grid(
  columns: (auto, 1fr),
  column-gutter: 1em,
  row-gutter: 0.6em,
  strong[To], data.to,
  strong[From], data.from,
  ..(if data.at("cc", default: none) != none { (strong[Cc], data.cc) } else { () }),
  strong[Date], data.date,
  strong[Subject], data.subject,
)
#v(0.2cm)
#line(length: 100%, stroke: 0.5pt + accent)
#v(0.2cm)

#for paragraph in data.body {
  par(paragraph)
}
