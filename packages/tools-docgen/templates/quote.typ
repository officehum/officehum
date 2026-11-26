#import "_officehum.typ": *
#let data = json("data.json")
#show: officehum-page

#grid(
  columns: (1fr, auto),
  {
    text(size: 9pt, fill: accent)[Quote for]
    linebreak()
    strong(data.customer.name)
    linebreak()
    lines(data.customer.at("address", default: ()))
  },
  align(right, {
    text(size: 20pt, weight: "bold", fill: primary)[Quote]
    linebreak()
    [No. ]
    data.number
    linebreak()
    [Date: ]
    data.date
    linebreak()
    [Valid until: ]
    data.validUntil
  }),
)
#v(0.8cm)
#table(
  columns: (1fr, auto, auto, auto),
  align: (left, right, right, right),
  stroke: none,
  table.header(
    strong[Description], strong[Quantity], strong[Unit price], strong[Amount (#data.currency)],
  ),
  table.hline(stroke: 0.6pt + primary),
  ..data.lines.map(item => (item.description, str(item.quantity), money(item.unitPrice), money(item.amount))).flatten(),
  table.hline(stroke: 0.4pt + accent),
)
#align(right, table(
  columns: (auto, auto),
  align: (left, right),
  stroke: none,
  [Subtotal], money(data.subtotal),
  ..(if data.at("tax", default: none) != none { (data.tax.label, money(data.tax.amount)) } else { () }),
  table.hline(stroke: 0.6pt + primary),
  strong[Total (#data.currency)], strong(money(data.total)),
))

#if data.at("terms", default: ()).len() > 0 {
  heading(level: 2, "Terms")
  list(..data.terms)
}
#if data.at("notes", default: none) != none {
  v(0.4cm)
  data.notes
}
