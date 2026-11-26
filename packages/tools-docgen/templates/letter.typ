#import "_officehum.typ": *
#let data = json("data.json")
#show: officehum-page

#align(right, data.date)
#v(0.6cm)
#lines((data.recipient.name,) + data.recipient.at("address", default: ()))
#v(0.8cm)
#if data.at("subject", default: none) != none {
  text(weight: "bold", data.subject)
  v(0.3cm)
}

#set par(spacing: 1.1em)
#data.salutation

#for paragraph in data.body {
  par(paragraph)
}

#v(0.3cm)
#data.closing

#v(1.2cm)
#data.signature.name
#if data.signature.at("title", default: none) != none {
  linebreak()
  data.signature.title
}
