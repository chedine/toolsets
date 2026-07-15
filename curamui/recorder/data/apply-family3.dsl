# Two parents + under-19 child, profile-driven. Register the applicant first
# with a matching lastName, then:
#   node replay.js apply-family3.dsl --param firstName=Gray --param lastName=Vance
param firstName = "Gray"
param lastName = "Vance"
click section "HCR Cases and Outcomes"
click shortcutgroup "Searches"
click shortcutitem Searches > Person
enter "${firstName}" as First Name
click button "Search"
click link "${firstName} ${lastName} - *" in "Search Results"
click tabmenu "New Application"
fill application from family3
