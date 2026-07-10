# Fresh-build-safe scenario: no literal ids anywhere.
click section "HCR Cases and Outcomes"
click shortcutgroup "Searches"
click shortcutitem Searches > Person
enter "bo" as First Name
click button "Search"
click link in "Search Results" at row 1
click link in "Current Cases" where Type = "Insurance Affordability"
click link in "Cases" at row 1
select nav "Determinations"
