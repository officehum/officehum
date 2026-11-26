#import "_officehum.typ": *
#let data = json("data.json")
#show: officehum-page

#text(size: 20pt, weight: "bold", fill: primary, data.title)
#linebreak()
#text(fill: accent, data.date)

#strong[Attendees: ] #data.attendees.join(", ")
#if data.at("absent", default: ()).len() > 0 {
  linebreak()
  strong[Absent: ]
  data.absent.join(", ")
}

#if data.at("agenda", default: ()).len() > 0 {
  heading(level: 2, "Agenda")
  enum(..data.agenda)
}

#heading(level: 2, "Notes")
#for item in data.notes {
  heading(level: 3, item.topic)
  list(..item.points)
}

#if data.at("decisions", default: ()).len() > 0 {
  heading(level: 2, "Decisions")
  list(..data.decisions)
}

#if data.at("actions", default: ()).len() > 0 {
  heading(level: 2, "Actions")
  table(
    columns: (auto, 1fr, auto),
    stroke: none,
    table.header(strong[Owner], strong[Action], strong[Due]),
    table.hline(stroke: 0.6pt + primary),
    ..data.actions.map(action => (action.owner, action.task, action.at("due", default: ""))).flatten(),
  )
}
