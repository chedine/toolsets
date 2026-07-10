# Determination flow: IA case -> Home -> Cases -> Medical Assistance ->
# Determinations -> Current Determination -> assert coverage period ->
# open decision -> assert banner fields + Summary tables -> Income nav.
click section "HCR Cases and Outcomes"
click shortcutgroup "Searches"
click shortcutitem Searches > Person
enter "bo" as First Name
click button "Search"
click link in "Search Results" at row 1
click link in "Current Cases" where Type = "Insurance Affordability"
select nav "Home"
click link in "Cases" where Name = "Medical Assistance"
select nav "Determinations"
select navitem "Current Determination"
# applied evidence changes split the determination into multiple coverage
# periods — assert the timeline endpoints with wildcards, then open the
# latest period's decision
expect row where Coverage Period = "1/1/2027 - *" and Decision = "Eligible"
expect row where Coverage Period = "* - 12/31/2027" and Decision = "Eligible"
click link where Coverage Period = "* - 12/31/2027"
expect "Decision" is "Eligible"
expect "Coverage Start Date" is "*/2027"
expect row in "Coverage Information" where Name = "Bo Stokes" and Category = "Adult" and AI/AN Indicator = "Yes"
select nav "Income"
expect row in "Medicaid Financial Unit" where Member = "Gwendolyn Morar" and Eligible = "Yes"
