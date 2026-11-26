// Office Hum's helpers for document templates (@officehum/tools-docgen).
//
// Every compile directory holds this file, the template, data.json (the template's data, checked
// against its schema) and brand.json (the business's branding). A template uses them with
//
//   #import "_officehum.typ": *
//   #let data = json("data.json")
//   #show: officehum-page
//
// Nothing here computes a figure: money() only prints a number the data already holds.

#let brand = json("brand.json")
#let primary = rgb(brand.primaryColor)
#let accent = rgb(brand.accentColor)
#let ink = rgb(brand.textColor)

// A figure from the data with two decimals and thousands separators: 1234.5 becomes 1,234.50.
// Rounds half away from zero, as the Word and Excel layouts do.
#let money(value) = {
  let cents = int(calc.round(value * 100))
  let sign = if cents < 0 { "-" } else { "" }
  let cents = calc.abs(cents)
  let digits = str(calc.quo(cents, 100)).clusters()
  let rest = calc.rem(cents, 100)
  let grouped = ""
  for (index, digit) in digits.enumerate() {
    if index > 0 and calc.rem(digits.len() - index, 3) == 0 { grouped += "," }
    grouped += digit
  }
  sign + grouped + "." + (if rest < 10 { "0" } else { "" }) + str(rest)
}

// Lines of text, one under the other; nothing for an empty list.
#let lines(items) = if items.len() == 0 { [] } else { items.join(linebreak()) }

#let letterhead() = {
  grid(
    columns: (1fr, auto),
    align: (left + horizon, right + horizon),
    if brand.logo != none {
      image(brand.logo, height: 1.4cm)
    } else {
      text(size: 16pt, weight: "bold", fill: primary, brand.companyName)
    },
    text(size: 8.5pt, fill: accent, lines(brand.address)),
  )
  v(0.3cm)
  line(length: 100%, stroke: 0.8pt + primary)
  v(0.5cm)
}

// The page, the type and the letterhead every built-in template uses: `#show: officehum-page`.
#let officehum-page(body) = {
  set page(
    paper: "a4",
    margin: (x: 2.2cm, top: 2.2cm, bottom: 2.4cm),
    footer: context {
      set text(size: 8pt, fill: accent)
      brand.companyName
      h(1fr)
      counter(page).display("1 / 1", both: true)
    },
  )
  set text(font: (brand.font, "Libertinus Serif"), size: 10.5pt, fill: ink)
  show heading: set text(fill: primary)
  letterhead()
  body
}
