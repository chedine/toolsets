# Parameterized: find a person, open them, verify they have an open
# Insurance Affordability case. Run for someone else with e.g.
#   node replay.js person-ia-case.dsl --param firstName=fra --param person="Francis Mertz"
param firstName = "bo"
param person = "Bo Stokes"
click section "HCR Cases and Outcomes"
click shortcutgroup "Searches"
click shortcutitem Searches > Person
enter "${firstName}" as First Name
click button "Search"
click link "${person} - *" in "Search Results"
expect row in "Current Cases" where Type = "Insurance Affordability" and Status = "Open"
click link in "Current Cases" where Type = "Insurance Affordability"
select nav "Evidence"
