#import "_officehum.typ": *
#let data = json("data.json")
#show: officehum-page

#grid(
  columns: (1fr, auto),
  {
    strong(data.customer.name)
    linebreak()
    lines(data.customer.at("address", default: ()))
  },
  align(right, {
    text(size: 20pt, weight: "bold", fill: primary)[Statement]
    linebreak()
    if data.customer.at("account", default: none) != none {
      [Account: ]
      data.customer.account
      linebreak()
    }
    [Date: ]
    data.statementDate
    linebreak()
    [Period: ]
    data.periodStart
    [ to ]
    data.periodEnd
  }),
)
#v(0.8cm)
#table(
  columns: (auto, auto, 1fr, auto, auto, auto),
  align: (left, left, left, right, right, right),
  stroke: none,
  table.header(
    strong[Date], strong[Reference], strong[Description], strong[Charges], strong[Payments], strong[Balance],
  ),
  table.hline(stroke: 0.6pt + primary),
  [], [], [Opening balance], [], [], money(data.openingBalance),
  ..data.lines.map(item => (item.date, item.reference, item.description, money(item.charges), money(item.payments), money(item.balance))).flatten(),
  table.hline(stroke: 0.4pt + accent),
  [], [], strong[Totals], strong(money(data.totals.charges)), strong(money(data.totals.payments)), strong(money(data.closingBalance)),
)
#v(0.6cm)
#align(right, block(fill: primary.lighten(88%), inset: 10pt, radius: 3pt, {
  text(size: 12pt)[Amount due (#data.currency): ]
  text(size: 12pt, strong(money(data.amountDue)))
  if data.at("dueDate", default: none) != none {
    linebreak()
    [Due by ]
    data.dueDate
  }
}))
#if data.at("message", default: none) != none {
  v(0.6cm)
  data.message
}
